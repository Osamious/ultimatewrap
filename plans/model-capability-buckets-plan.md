# Implementation plan: per-model capability buckets for `behavesAs`, and the routability wire-up

**Branch:** `fix/model-capability-buckets` (based on `phase6` @ `2c20302`)
**Status:** approach decided and evidence-backed. This document sequences it; it does not re-open it.
**Revision 5** (2026-09-06). R2 folded in the first Architect + Critic review (§8); R3 the
routable-dimming scope addition as T4 (§9); R4 the second review pass (§10); R5 the final pass (§11).
No re-sequencing since R3 — the ten tasks and two lanes are unchanged. Both reviewers have said R5
closes it.
**Authorities:** `research/phase6/18-behavesas-capability-profile.md` §8, §9, §10;
`research/phase6/19-deepseek-harness-counterfactual.md` §6;
`research/phase6/03-ccr-capabilities.md:150-184`;
`plans/claude-sub-models-plan.md` "Decision 4 REVERSED, 2026-09-06".
**Test runner:** `node --test "test/*.test.mjs"` — 355 pass at HEAD. That number must not regress.

---

## 0. RALPLAN-DR

### Principles

1. **Unknown is a third value, never a coerced `false`.** `menu/catalog.mjs` already lives by this for
   `routable` (`makeRoutableOf`, 143-144) and `free` (198). The three capability fields are the
   inconsistent ones. dsh states the same rule as load-bearing rather than pedantic (report 19 §6.1).
2. **Validate at build, not at use** (report 19 §6.3) — **and assert each invariant where its subject
   exists.** An invariant about `options[]` cannot live in a function that runs 362 lines before
   `options[]` is constructed. This is why §5 has two tiers.
3. **Under-declare, never over-declare.** Report 18 §10.6: of the eight gated predicates, five are
   free to under-declare, one is self-healing, one is free either way, four are dangerous to
   over-declare. Every ambiguous case resolves toward the weaker bucket — **including the non-chat
   rows** (D6, where revision 1 broke this).
4. **Show, never hide.** A non-chat row renders, dimmed and unselectable *in uwpick*. In
   `modelPicker.options[]`, dropping a row also drops its capability declaration (§1.8), so omission
   is never merely cosmetic there.
5. **Positive signals block; absent signals do not.** Coverage has holes and one measured error
   (`nvidia/bge-m3` declared `output: ["text"]`). A field must be present *and* disqualifying before
   it costs the user a row.
6. **Block only when selection cannot possibly succeed; dim when it might.** Impossibility, not
   perishability. An image model cannot answer a chat request under any configuration, so it may be
   blocked. A row CCR did not list at snapshot time may be routable now, so it may only be dimmed.
   **One standing exception: a security control may block a row that would route perfectly well.**
   `menu/denylist.mjs`'s `admitId` and `admitRemoteModels` reject `UW_ALIAS` squatting, over-length
   ids and `@cf/` scoping — namespace ownership, not impossibility. Named here so the principle does
   not read as forbidding them.
   *(R3 first stated this as "skip on facts, dim on measurements", which collided with Principle 5 —
   that exists because a catalogue* fact *was measured wrong. R4 then reconciled the reformulation
   against `--verified-only` as legitimate precedent. **That reconciliation is withdrawn**: the
   standing rule below supersedes it, and `--verified-only`'s pruning is non-compliant under it.
   Principle 6 stands on impossibility-versus-uncertainty alone, plus the security-control exception
   above.)*

**A standing project rule, set 2026-09-06, that governs beyond this plan:**

> **A provider that is alive and responding is never classified dead or removed from routing.**
> Account-state failures — insufficient funds, overdue balance, wrong or expired key, missing credits
> or licences, eligibility walls — are *state*, not death. Surface them in uwpick (the existing
> `health` column, or a new one) and never use them to block or eliminate routing. Only a genuinely
> absent model (404 / "does not exist"), a decommissioned one, or a provider that does not respond at
> all may be treated as unroutable.

Measured: 57 of 218 live probes (26%) failed on money rather than absence — `402 Payment required`,
`402 Insufficient Balance`, `403 Access to model denied`. Alibaba had 343 catalogued, 73 entitled,
two recorded passing the real-client gate in `keysync/verified-rows.json` on 2026-09-01, then 403 on
everything five days later over an unpaid bill. `keysync/verify-cli.mjs:38-39` records the sibling
scar in its own words — pruning on a transient failure is "a one-way ratchet: a row dropped for a
transient failure was never probed again, which is how mistral was lost to a single 503" — and an
unpaid balance is worse, because a 503 clears itself and a balance does not clear until the user
acts. **This is why D9-A is the only compliant choice for `routable`, and it is recorded in
`plans/open-questions.md` as a decided follow-up along with `--verified-only`'s non-compliance.**

### Decision drivers (top 3)

1. **Correctness of the input signal gates everything else.** `!!undefined === false` at
   `menu/catalog.mjs:178` makes every unknown model look like a known-small one.
2. **Zero new matching surface.** The measured false positive (`orcarouter/auto` ↔ `morph/auto`) came
   from cross-provider name matching. The plan adds none: the row-building loop already holds the
   entry it needs (§1.4).
3. **Every change must be legible in the diff, and no verification step may pass vacuously.** 32.5% of
   rows must be byte-identical — the control group proving the classifier ran. Symmetrically, a task
   whose verification can succeed by having no effect (T7 without T1, §1.9) is not verified. **T4
   exists because three defects each masked the other two, so fixing any one alone would have
   produced exactly today's artifact** (§1.10).

### Viable options (implementation shape)

Nine sub-decisions. D6-D8 were added in R2; D9 is new in R3.

#### D1 — where the classifier reads its input

| Option | Pros | Cons |
|---|---|---|
| **A (recommended): read the catalogue entry already in hand at `keysync.mjs:349-372`; carry derived scalars onto the normalized model object** | No new lookup, so cross-provider matching is structurally impossible. Both row paths already resolve their entry there. Smallest diff. | Widens the normalized object by three fields; two push sites to keep in sync. |
| B — re-match at the `behavesAs` write site | Keeps the object narrow. | Re-introduces a lookup someone can later loosen. Duplicates work done 60 lines above. Rejected on driver 2. |
| C — carry the whole raw entry through | No field-selection decisions. | Puts a 46-key upstream object into UW's shape; every upstream schema change becomes a UW change. Rejected. |

#### D2 — how a non-chat row is made visually distinct from a non-routable one

| Option | Pros | Cons |
|---|---|---|
| **A (recommended): dim the row (reuse `style.mjs:358`) and render the modality label in the `ctx` cell** | Zero width change (`W.ctx = 6` fits `AUDIO`/`VIDEO`/`IMAGE`). Removes an active lie: `google/veo-2` carries `contextTokens: 480`, a video duration in seconds; `google/lyria` carries `0`. | Makes `ctx` polymorphic — one branch at the single call site (`style.mjs:350`), which T5 already edits. R1 overstated this as a change to `ctxS()` itself. |
| B — the `badge` cell | Badge is already a label column. | Collides with `FREE`/`PLAN`/`PAID`, which are genuine facts about the same row. |
| C — a fourth capability glyph | Uniform with `T`/`V`/`R`. | **A glyph cannot name *which* modality**, which is the point of the cell. That is the sufficient reason. *(R1 also claimed the layout tests would break; `test/menu-layout.test.mjs` has no width assertions — §8 C4. Withdrawn.)* |

**Interaction with D9, worth stating:** after T4 a row can be dimmed for *two* reasons. Non-chat rows
get the modality label in `ctx`; non-routable rows keep their real `ctx` and are disclosed by the
`routable <date>` header stamp. Distinguishable without new width.

#### D3 — the bucket for a row with no signal at all

38 of 83 rows (46%) have no catalogue entry — no `reasoning`, no context.

| Option | Pros | Cons |
|---|---|---|
| **A (recommended): weak target, under a distinct `"unknown"` classification** | Principle 3. The distinct classification keeps "we do not know" and "we measured it small" separately countable, and makes mutation boundary 3 falsifiable (§4.2). | 38 rows change value. The user loses an effort selector CCR strips before the wire for 43 of 45 providers anyway. |
| B — capable (today's value) | Zero diff for 46%. | Preserves the over-declaration this task exists to remove, where it is least justified. |
| C — omit `behavesAs` | Maximally honest. | Report 18 §3 measured this as worse than any bucket; OQ-1 re-confirmed it independently (`lH()` → maximal assumption set). **Invalidated twice.** |

#### D4 — the shape of the bucket table

- **Chosen: a frozen `BUCKET_TARGETS` map plus a frozen `ALLOWED_BEHAVES_AS` allowlist, validated in
  `validate()`.** Report 19 §6.3 at UW's scale.
- *Rejected — a denylist instead of an allowlist.* A denylist passes a typo (`claude-sonnet-4-51`)
  silently, and silently is the failure mode the rule exists to prevent. The denylist survives as a
  *second* rule with its own sentence.

#### D5 — the shape of the Decision 4 reversal

**A correction that shrinks the decision:** `run.mjs:465` already does
`built.picker.unshift(...pickerRows)`, and no vault provider can be named `anthropic`. **The
Anthropic-first partition is already true; any ordering function is `[...rows]` today.** T1's
substance is *stop filtering*, not *start ordering*.

| Option | Pros | Cons |
|---|---|---|
| **A (recommended): keep the exported seam, rename to `orderNativePickerOptions`, implement as a stable partition returning a new array** | A **defensive invariant, not a transformation**: one line makes Anthropic-first true locally rather than by an accident of `unshift` 400 lines away. Keeps a tested export. | A no-op on today's data is easy to mistake for dead code. Mitigated in its comment. |
| B — delete the function | Honest about the no-op. | Deletes the only seam where "every row reaches `options[]`" can be asserted, and the four tests with it. |
| C — in-place `sort` | One line. | Mutates; `built.picker` is read afterwards at `:842` and `:681`. A hazard of a function that need not exist. |

**Sub-decision: the relay-down fallback is deleted, not rethought.** Once nothing is filtered,
`options[]` is the full built set. *(R1 cited `run.mjs:385`; that guard is nested inside
`if (has("--verified-only"))` at `:370` and never runs by default — §8 C5. The real guard is the
post-write check at `:882-883`, throwing into the catch at `:891`.)*

#### D6 — what a non-chat row declares

R1 said non-chat rows carry **no** `behavesAs`, reasoning that T5 makes them unselectable. **T5's
selectability concept exists only in uwpick; the native `/model` menu has none**, and §1.8(3) shows a
row with no `behavesAs` resolves to the *maximal* assumption set plus a launch warning. R1 shipped 4
rows in exactly the state this branch exists to remove.

| Option | Pros | Cons |
|---|---|---|
| **A (recommended): non-chat rows carry the weak target, classified `"nonchat"`** | Restores Principle 3. The target is *inert* — unselectable in uwpick, and the model cannot serve a chat request — so it costs nothing and buys the absence of maximal resolution. Makes T9 step 4 satisfiable and V5 checkable. | A user selecting one from the native menu still gets a model that cannot answer. True today; unchanged. |
| B — omit (R1) | Reads as honest. | Measured as the maximal over-declaration. **Rejected on direct evidence.** |
| C — drop from `options[]` | Shortest menu. | The drop-the-declaration move OQ-1 established is a regression, applied deliberately. |

#### D7 — the fate of `UW_BEHAVES_AS`

R1 kept it as a whole-table override **and** specified V6 (`capable !== weak`). One env value sets
both buckets equal, so V6 fails the build the first time anyone uses the hatch.

| Option | Pros | Cons |
|---|---|---|
| **A (recommended): retire it; the table is the escape hatch** | It overrode a *single constant*; with a two-entry table there is no single value to override. Two allowlist-validated lines beat an env var that fails silently on a typo. Removes the V6 conflict outright. | Loses a no-rebuild toggle, for the one operator this repo has. |
| B — two env vars, V6 downgraded to a warning when either is set | Preserves the hatch. | Two code paths and a conditional-severity rule, for a toggle with no known use. |
| C — keep one, exempt it from V6 | Smallest diff. | Ships a documented way to silently disable the classifier. |

**T7 must grep-confirm `:120` is the only reader before removing it.**

#### D8 — where each invariant is asserted

`validate({providers, picker}, expectedCount)` (`keysync.mjs:428`) receives the built set and nothing
else. R1 put V5 and V7 there. V5 needs each row's `kind`; V7 needs `optionRows`, which does not exist
until `run.mjs:867`.

| Option | Pros | Cons |
|---|---|---|
| **A (recommended): two tiers. Put `kind` on the row so V1-V6 stay in `validate()`; add `assertOptionsComplete(builtPicker, writtenOptions)` after the `settings.modelPicker` assignment and before `atomicWriteJson` at `:878`, for V7-V8** | Each invariant asserted where its subject exists (Principle 2). Throws into the **existing** catch at `:891`, which already restores from backup — no new failure machinery. **Makes T1 permanent: once T1 lands, it can never be silently un-landed**, which is what boundary 6 describes. ~20 lines. | Requires extending the strip at `:869` to `({contextTokens, kind, ...row})`, or `kind` leaks into a file whose zod schema is exactly `{model, label?, description?, behavesAs?}`. V8 pins that. |

**Argument position matters and R3 got it wrong.** `optionRows` at `:867` is the **pre-strip** array:
`:869` strips into a *different* array via `.map(({contextTokens, ...row}) => row)`. Handing
`optionRows` to V8 would fire on every row of every clean build — `contextTokens` is set at
`keysync.mjs:420`, and T7 step 4 adds `kind` — throwing into the rollback and making T8's own
acceptance criterion unsatisfiable. **Call it after the assignment, on
`settings.modelPicker.options`.** `model` survives the strip, so one array serves both rules: V7
compares presence on `model`, V8 checks the key set of what will actually be written.

**What it does not do.** R3 claimed this "mechanically enforces T1 ⇒ T7" in five places. It cannot:
`assertOptionsComplete` is introduced in T8, downstream of both, so at the moment a T7-without-T1
commit could exist the guard does not. The ordering is enforced instead by the two measures in §1.9.
| B — pass the catalogue into `validate()` | One site. | V7 still cannot be expressed there. Does not solve the problem. |
| C — drop V5 and V7 | No new code. | V7 is what makes §1.8(3) impossible to reintroduce, and boundary 6 has no seam without it. |

#### D9 — does `routable: false` dim only, or dim and skip? (NEW)

Severity is settled and must not be re-derived: `ModelRegistry.resolve()`
(`research/phase6/03-ccr-capabilities.md:150-184`) resolves `provider/model` at stage 2 via
`j3(c, o.model)` against that provider's own array; a miss falls through stages 3-5 and returns
`undefined`. **Selecting a non-routable row fails loudly — it does not silently reroute.** This is a
UX defect (offering choices that error), not a correctness or security one.

| Option | Pros | Cons |
|---|---|---|
| **A (recommended): dim only — no selector change** | Principle 6: a row CCR did not list at snapshot time may be routable now, so selection is *uncertain*, not impossible. Skipping would convert snapshot staleness into a functional block on up to 94% of rows. **Measured support, 2026-09-06: ~205 of 1,588 models are reachable at current account balances and ~260 if the unfunded accounts were paid — so the dim will cover roughly 114 models that are genuinely reachable but absent from `Providers[].models`. Blocking on `routable` would block reachable models.** Also: the failure is loud and immediate (`ModelRegistry.resolve()` returns `undefined`), so a user who selects one learns at once rather than being misrouted. **And it requires zero new code** — `style.mjs:358` already dims on `false`. | ~1,497 rows remain selectable-but-erroring. The dim is the only warning. |
| B — dim and skip, like `nontext` | Removes ~1,497 dead choices. | Blocks on a measurement that can be stale or wrong, with no override. If `routableSet()` ever returns a partial set, the picker silently loses rows the user can actually reach. The `fresh`/`null` guard protects against the *all-unknown* case but not against a *wrong* answer. Rejected on Principle 6. |
| C — dim, and require a confirmation keystroke on enter | Keeps the choice, adds friction. | New modal machinery in a reducer whose whole design is that it has none. Rejected as scope. |

**State the asymmetry plainly in the code comment**, because a future reader will ask why two dimmed
row classes behave differently: one is a fact about the model, the other a measurement of a
configuration.

---

## 1. Measured baseline (verified on this branch, 2026-09-06)

### 1.1 The 83 rows

`keysync/built-rows.json` — 83 non-Anthropic targets. Strict `{provider, model}` match against CCR's
bundled catalogue (4,298 models): **45 matched (54.2%)**, 38 with no entry (vault `testModel` only).
Of the 45: `capabilities.reasoning` is `true` 24, `false` 12, absent 9.

### 1.2 Predicted classification

| classification | rows | target |
|---|---|---|
| `nonchat` | 4 | weak (D6) — `google/lyria`, `google/veo-2`, `nscale/flux.1-schnell`, `nscale/stable-diffusion-xl-base-1.0` |
| `capable` — `reasoning === true` | 24 | capable |
| `capable` — context proxy ≥128,000 | 3 | capable |
| `weak` — `reasoning === false` | 10 | weak |
| `weak` — context proxy <128,000 | 4 | weak |
| `unknown` — no signal at all (D3) | 38 | weak |

**27 → `claude-sonnet-4-6`; 56 → `claude-sonnet-4-5`; every row carries a declaration.** Four
classifications, two targets: the extras exist to make the audit countable and boundary 3 falsifiable.

### 1.2a Zero-diff share, and what the audit may not claim

**Baseline A — the live `settings.json` (87 rows), stale per §1.8.** All 83 non-Anthropic rows present
before and after, so the denominator is **83**: 27 byte-identical (**32.5%**), 56 changed, **0 losing
`behavesAs`** (changed from R1 by D6).

**Baseline B — what HEAD would write on a healthy live run (4 rows).** All 83 are net additions; zero
diff is meaningless. Recorded only to justify T0.

**Retracted from R1:** the claim that the four Anthropic rows are also a zero diff.
`deriveAnthropicSets` sets `pickerIds` from the **live** catalogue, not the curated four
(`run.mjs:283-285` says so), so the Anthropic half churns for reasons this branch does not own.
Reading that churn as a T1 regression is the misreading the audit exists to prevent. T9 asserts
Anthropic *properties*, never *counts*.

### 1.3 The context proxy has a natural gap

`mistral/mistral` 8192, `ollama/llama2` 4096, `ollama/llama3` 8192, `cohere/command` 4096 |
`cerebras/llama3.1-8b` **128000**, `cloudflare/granite-4.0-h-micro` 131000,
`sambanova/gemma-4-31b-it` 131072. Nothing between 8,192 and 128,000, so the cutoff is **128,000
inclusive** — a real model sits exactly on it, making `>=` vs `>` a one-character mutation with a
visible consequence.

### 1.4 Field plumbing: needed, cheap, and name-sensitive

`keysync/keysync.mjs` normalizes to `{id, tier, contextTokens}` at two sites:

- `:352-357` testModel — `safeEntries.find((m) => m.model === safeTestModel)`; `cat` may be
  `undefined` (38 of 83). **Already a strict same-provider lookup.**
- `:367-369` catalogue-ranked — iterates `safeEntries` = `catalog.byProvider.get(provider)`. **Entry
  in hand by construction.**

**The field is `contextTokens`.** `ctx` is the *menu* pipeline's name (`menu/catalog.mjs:176`). R1's
`bucketFor({kind, reason, ctx})` would have read `undefined` for every keysync row, silently sending
all 7 proxy rows to weak (27/56 → 24/59) while literal-driven unit tests stayed green. T6/T7 name it
once, and §4.1 requires one test that feeds `bucketFor` a **pipeline-produced object**.

### 1.5 `modalities.output` — shape and honest limits

Present on **4,298 / 4,298**; `output` always an array. `text` 3797, `image` 141, `embedding` 95,
`audio` 61, `audio+text` 54, `video` 52, `image+text` 43, `score` 22, `embedding+text` 16,
`text+video` 10, `image+pdf` 3, `audio+image+text` 2, `score+text` 2.

- 100% presence means "genuinely unknown type" arises **only** when the row has no catalogue entry.
- 100% presence also means `["text"]` is likely a *default*. **Only a positive non-text signal may
  block** (Principle 5). Confirmed by a measured error: `nvidia/bge-m3` is an embedding model declared
  `output: ["text"]`, and the classifier will pass it.
- **Of the 135 entries whose output contains `embedding` or `score`, 117 have no `text` and are caught
  by the ordinary rule; only 18 also carry `text` and need the special clause.** R1 cited 135 —
  corrected. 18 catalogue-wide, 0 among today's 83, still worth one clause because uwpick's snapshot
  is a ~1,588-model surface.

### 1.6 `contextTokens` is not trustworthy for non-text rows

`google/veo-2` carries `480` (video seconds); `google/lyria` carries `0`. Both numbers, so a naive
proxy reads them as tiny models. **This is why the non-text check is step 1 of the order.**

### 1.7 Live exposure

`~/.claude/settings.json`: `modelPicker.options` has 87 rows — 4 Anthropic, 83 non-Anthropic, all 83
at `behavesAs: "claude-sonnet-4-6"`.

### 1.8 OQ-1, resolved: the file is stale, and `options[]` has two jobs (build 2.1.261)

1. **Stale, not a relay-down artifact.** `run.mjs:867`'s scoping would have written 4 rows with the
   relay up. keysync has not run `--target live` since commit `4151639`.
2. **`modelPicker.options[]` is simultaneously the rendered `/model` row list (`Ato()` iterates it)
   and the only registry that can hold `behavesAs` (`_re()` reads the same array).** Dropping a row
   drops that model's declaration. Decision 4 was made without this being known.
3. **So the scoping is a silent capability regression on the healthy path:** an id with no `behavesAs`
   resolves through `lH()` to the *maximal* assumption set — every effort tier, adaptive thinking on,
   thinking forced un-disableable — plus an unknown-model launch warning. Report 18 §3 measures that
   as strictly worse than any bucket target.
4. **The alternatives are dead.** `modelOverrides` confers the identical profile but is keyed by
   *Anthropic* id against a 19-model baked catalog (caps at 19, not 83), and a first-party-spelled key
   hijacks that model's outgoing id via `a_()`. No hidden-row field exists — the schema is exactly
   `{model, label?, description?, behavesAs?}` per the binary's zod definition. `modelSettings` has
   the right cardinality and no rows but carries only `effortLevel`.

### 1.9 Why T1 must precede T7 — corrected

R1 argued T7-first would be a regression. **It would not: the scoping is already live, so a T7-only
build is byte-identical to HEAD for the 83 rows.** The real reason is worse:

**T7 without T1 produces a false green.** No third-party row reaches `options[]`, so T9's diff audit
finds no wrong `behavesAs` and the task appears to have succeeded — by having no effect.

**Three mechanisms, with three different jobs. Exactly one of them orders anything** — R4 labelled the
first two as "two ordering measures", which overstates the first:

1. **Orders T1 before T7: T7's end-to-end acceptance runs through `orderNativePickerOptions`, not a
   bare fixture build.** As R3 wrote it, T7's distribution assertion passed identically with or
   without T1 — the exact vacuity this section exists to name. Routed through the ordering function,
   it can only be satisfied when every row survives to `options[]`. **This is the ordering measure.**
2. **Makes T1 permanent from its own commit: the rewritten `test/denylist.test.mjs:1011` test** —
   *"every built row reaches `options[]`"* — lands with `orderNativePickerOptions` in T1. This is a
   durability property, not an ordering one: if T7 landed without T1 the test would not exist either.
3. **Extends that permanence to the write site: `assertOptionsComplete` (T8).** Catches a future
   re-scoping introduced at `run.mjs:867`, which no unit test on the ordering function can see.

### 1.10 The routability gap: five defects, each masking the others (NEW)

Measured directly on `~/.uw/catalog/snapshot.json` (schema 1, built 2026-09-04):
**1,588 of 1,588 models carry `routable: undefined` — the property is absent, not `null`.** Live CCR
routes 91 models across 45 providers, so ~1,497 undimmed rows cannot route.

The coordinator's framing was "the snapshot was built on the `fresh: false` path." That is one of
**five independent breaks**, and fixing it alone would change nothing:

| # | break | evidence |
|---|---|---|
| **B1** | `build()` never requests routability. `menu/catalog.mjs:226-228` calls `buildFrom({chosen, providers, catalog, relay})` with **no `routableOf`**, so it defaults to `() => null` (`:158`). **`routableSet()` is called by nothing but its own test.** | grep: the only non-test callers of `routableSet` are zero |
| **B2** | Even a populated field is dropped at serialization. `menu/snapshot.mjs:29-32` maps models to an explicit 8-key literal that omits `routable`. | live snapshot keys are exactly `["id","ctx","pin","pout","badge","tools","vision","reason"]`; `hasOwnProperty("routable") === false` |
| **B3** | The disclosure stamp is never written. `buildSnapshot` returns `{schemaVersion, generatedAt, builtAt, rows}` — **no `routableAsOf`** — while `uwpick.mjs:56` reads it and `style.mjs:269-271` renders it. So the header has always shown a dash. | live snapshot top-level keys omit `routableAsOf` |
| **B4** | A test certifies B2 as correct. `test/snapshot.test.mjs:39` asserts the model key set is exactly the 8 keys, so restoring `routable` **fails a currently-green test**. | read directly |
| **B5** | **The causal root: a comment names a caller that does not exist.** `menu/catalog.mjs:107-110` states *"This function has exactly one caller, `refresh/cli.mjs`, which has an event loop, no latency budget, and a reason to be talking to CCR anyway."* **There is no `refresh/` directory.** `plans/phase6-menu-and-catalogue.md:289` lists `refresh/cli.mjs` as "the one place routability is resolved and stamped onto the snapshot (Q1.3)" — a planned module that was never built. | `ls refresh` → no such directory |

**This is why the gap survived design review, twice over.** B5 is the mechanism: the wire was not
forgotten, it was designed to originate in a module that does not exist, under a comment asserting
the caller does — so a reader auditing `routableSet` finds a confident sentence rather than an
absence. And `menu/catalog.mjs:122-126` explains that undimmed-because-unknown and
undimmed-because-routable look alike, "which is why `routableAsOf` is printed in the header rather
than left implicit" — B3 is precisely that disclosure never being wired. The mechanism built to make
the failure visible failed silently itself, and the comment that would have exposed the missing
caller asserted its existence instead. **By T1 step 6's own standard, a correct-looking line resting
on a false premise is the defect to fix.**

**Contributing factor, not a break:** `routableSet({timeoutMs = 400})` returns `{set: new Set(),
fresh: false}` when the gateway does not answer (`catalog.mjs:130`). Once B1 is fixed, a 400 ms
timeout on a build that already parses a 19.7 MB catalogue would silently reproduce today's artifact.
T4 therefore raises the budget **and makes the degraded path announce itself**, because a silently
degraded snapshot is what this whole gap is made of.

**Consequences for sequencing:** B2, B3 and B4 all touch `buildSnapshot` and
`test/snapshot.test.mjs:39` — the same two places T2 and T3 touch. T4 belongs immediately after T3, in
the same lane, so the snapshot shape changes once. See §2's lane note.

---

## 2. Sequenced tasks

Ten tasks. Each ends green (`node --test "test/*.test.mjs"`, ≥355 pass) and is independently
committable.

**Two lanes, one join:**

```
T0 ─┬─ T1 ──────────────────┐
    │                       ├─ T9
    ├─ T2 ─ T3 ─ T4 ─ T5 ───┤
    └─ T6 ─ T7 ─ T8 ────────┘
                 ▲
            T1 ──┘   (T1 ⇒ T7; see §1.9)
```

- **Catalogue lane (T2 → T3 → T4 → T5)** — ~1,588 models, uwpick's snapshot and picker. It depends on
  T0 only for ordering convenience, **not on T1**; R3's diagram implied otherwise and contradicted its
  own prose.
- **Declaration lane (T1, T6 → T7 → T8)** — the 83 routable rows, keysync and settings.json.
- **T1 ⇒ T7** (§1.9). Enforced by T1's own rewritten `:1011` test and by routing T7's acceptance
  through `orderNativePickerOptions` — **not** by T8's `assertOptionsComplete`, which is downstream of
  both and so cannot order them.
- **T4 does not lengthen the critical path**, which runs T1 → T7 → T8 → T9. It sits in the parallel
  lane, and goes *after* T3 specifically so the snapshot key literal and `test/snapshot.test.mjs:39`
  are edited once per field rather than twice for the same reason.

**The schema bump happens once, in T4** — not in T2 as R2 had it. Rationale: `loadSnapshot` validates
only `schemaVersion` and `Array.isArray(rows)`, never fields, so adding `kind` and `routable` is
backward-tolerant and nothing breaks mid-lane. The bump's only job is to *force* a rebuild of a
snapshot whose `tools`/`vision`/`reason` values are the old coerced lie. One bump plus one rebuild at
the end of the lane avoids a mid-lane HUD outage (§1.10 / C6) and avoids rebuilding twice.

**Landing recommendation.** T1 alone closes the capability regression: it restores all 83 declarations
at today's uniform value, which §1.8 shows is strictly better than none, and closes OQ-1 and OQ-2.
Everything after refines declarations that are already safe. **T1 should be its own commit, landing
first and independently**, so a stall in T6-T8 does not hold the fix hostage.

**The catalogue lane has the opposite property, and it must be said symmetrically.** T2's tri-state
fix and T3's `kind` field have **zero user-visible effect until T4 lands**, because nothing forces a
snapshot rebuild before T4's schema bump — the picker keeps reading the schema-1 file with its
coerced capability values. A stall in T4 therefore leaves T2 and T3 inert rather than partially
delivered. If that lane must be abandoned mid-way, the honest options are to land T4 or to revert
T2-T3; leaving them merged and unrebuilt is the state that reads as done and is not.

---

### T0 — Capture the baseline into a tracked location *(no production code)*

*Corrected premise.* R1 claimed one live run destroys it. `run.mjs:733-736` backs up settings.json
before every live write and `retainOnSuccess` keeps one, so **two** runs are needed. But retention is
not reliably chronological: `keysync/safety.mjs:112` sorts filenames `.sort().reverse()`, and two
stamp formats coexist on disk (`uw-backup-20260905T090726`, `uw-backup-2026-09-05T05-52-03-334Z`);
`'-' < '0'`. **Do not rely on the backup to be the baseline.**

1. Write the 83 `target → behavesAs` pairs plus the full `options[]` model order to
   `keysync/behaves-as-before.json` — **tracked, beside `built-rows.json`**, not
   `research/phase6/_tmp/`, which is gitignored and survives neither `git clean -xfd` nor a branch
   switch, while T9 consumes it nine tasks later.
2. Commit it with T0. It is evidence, and its whole value is surviving to T9.

**Acceptance:** tracked by git; 83 entries, all `claude-sonnet-4-6`; `anthropic/` rows contiguous at
the head of the recorded order.

---

### T1 — Reverse Decision 4: `options[]` carries every row *(candidate standalone commit)*

**Depends on:** T0. **Required by:** T7.
**Files:** `keysync/run.mjs`, `test/denylist.test.mjs`, `plans/claude-sub-models-plan.md`.

1. Rename `scopeNativePickerOptions` → **`orderNativePickerOptions`** (`:310`); change from filter to
   stable partition returning a new array (D5-A). No `sort`, no mutation — `built.picker` is read
   afterwards at `:842` and `:681`.
2. **Comment states the partition is a defensive invariant, not a transformation**: `:465`'s `unshift`
   already puts relay rows first, so this is a no-op on today's data and exists to make the property
   true locally rather than 400 lines away.
3. **Delete the relay-down fallback** (`:311-314`). Justify via the post-write check at `:882-883`
   throwing into the rollback at `:891` — **not** `run.mjs:385`, which is `--verified-only`-gated.
4. Rewrite the doc comment (`:294-309`) and the block comment at `:856-865` ("what this drops is 83
   rows of third-party noise" — now false) with §1.8(2).
5. Rewrite the `console.log` at `:872-876`; "the other N rows stay reachable via uwpick / ctrl+g"
   becomes false and would read as reassurance about a regression.
6. Fix the stale premise in `reconcileUserModelPin`'s comment at `:836-841`. The code stays correct;
   only its stated reason is wrong — and step 4 makes shipping a false justification the defect to fix.
7. Rewrite the four tests at `test/denylist.test.mjs:973-1022` (§4.1).

**Acceptance criteria:**
- Returns **all** input rows; every `anthropic/` row precedes every non-`anthropic/` row; non-Anthropic
  rows keep input relative order.
- Input array and every row object `deepEqual` a pre-call snapshot; result is a different reference.
- With no Anthropic rows, all rows returned unchanged and in order.
- No call site or test imports `scopeNativePickerOptions`. **Scope the check to `keysync/ menu/
  test/`** — a bare repo-wide grep also hits `plans/open-questions.md` and this plan, both of which
  record what the code *used to do* and are correct to keep the old name. Executed at T1: prose
  left alone deliberately.
- **The V7 property is asserted here, not deferred to T8** (§1.9 measure 1): the rewritten `:1011`
  test asserts `dropped.length === 0`, so from this commit onward restoring the filter fails a test
  rather than waiting for a guard that does not exist yet.

---

### T2 — Piece 1: tri-state capabilities *(catalogue lane, ~1,588 models)*

**Required by:** T3. **Files:** `menu/catalog.mjs`, `menu/style.mjs`, `test/catalog.test.mjs`,
`test/uwpick.test.mjs`, **`test/style.test.mjs`** (its frame literals include the `TVR` cell, so the
tri-state glyph lands there).

*(R3 listed `test/snapshot.test.mjs` here. With the schema bump moved to T4 there is nothing to do in
it at this task: its `BUILT` fixture is a hand-written literal that never passes through `buildFrom`,
so `capsOf` cannot reach it. Removed.)*

**Why a prerequisite, accurately.** `menu/catalog.mjs` imports `keysync.mjs`, never the reverse, and
the bucketer reads `loadCatalog()` directly — so this is **not** a data dependency of the declaration
lane. It is a prerequisite because T3 and T4 add fields to the same object in the same file, and
because the `!!` bug makes uwpick's `T`/`V`/`R` column lie today, independently of bucketing.

1. `export function capsOf(entry)` → `{tools, vision, reason}` as `true | false | null`, `null`
   meaning the upstream key is absent. Comment cites `!!undefined === false` and report 18 §9.2.
   Replace `:178` with `...capsOf(e)`.
2. **Audit the two synthetic-row sites:**
   - `:189-193` testModel rows, currently all-`false`. Such a row exists *because* the catalogue has
     no entry, so `false` is a claim the code cannot support → **`null`**.
   - `:209-212` relay rows, currently all-`true`. Keep **`true`**, with the reason in the comment:
     the four Anthropic subscription models, known first-hand rather than catalogued. The only
     all-`true` set in the file that survives the audit.
3. `menu/style.mjs:336` — `cap()` renders `false` and `null` identically as `p.dim("-")`. Left alone,
   a correctness fix creates a *new* ambiguity. Make it tri-state: `true → p[colour](ch)`,
   `false → p.dim("-")`, `null → p.dim("?")`. ASCII, one column, `W.caps` unchanged.

**Acceptance:** `capsOf({capabilities: {}})` → all `null`; `capsOf({capabilities: {reasoning: false}})`
→ `reason: false`, others `null`. testModel rows `null`, relay rows `true`. Three visually distinct
cells at unchanged width.

*(R1 listed `test/menu-layout.test.mjs` as the width guard; that file has none — §8 C4. But **real
width guards do exist**, in `test/style.test.mjs` — R2-R4 wrongly generalized the correction into "no
width assertions anywhere". See §4.3. Nothing needs writing; R4's offer to add an assertion is
withdrawn because `test/style.test.mjs:238` already is it.)*

---

### T3 — Piece 2a: an output-modality field *(catalogue lane)*

**Depends on:** T2. **Files:** `keysync/keysync.mjs`, `menu/catalog.mjs`, `menu/snapshot.mjs`, tests.

1. `export function outputKind(entry)` in `keysync/keysync.mjs`, placed beside `inferTier` for
   locality — it is the other entry→label function over the catalogue. **The rule exemplar is
   `makeRoutableOf` (`menu/catalog.mjs:143`), not `inferTier`**: a live probe confirms `inferTier`
   reads `pricing.inputPerMillion` while this schema stores `pricing.offers[].per1MTokens`, so it
   returns `"unknown"` for **0 of 4,298** entries' worth of real signal and the free-first sort at
   `keysync.mjs:365` is a no-op. `menu/catalog.mjs:29-31` already documents this verbatim. Citing a
   dead function as the model for honest-unknown labelling would be unfortunate in a plan whose
   Principle 1 is exactly that; recorded as OQ-5 rather than fixed here.
   Returns `"text" | "nontext" | null`:
   - no entry / no `modalities.output` array → `null`
   - output contains `embedding` or `score` → `"nontext"` **even alongside `text`** (18 catalogue
     entries need this clause; the other 117 are caught by the next rule)
   - output contains `text` → `"text"` (multimodal chat like `image+text` stays selectable)
   - otherwise → `"nontext"`
   - comment names `nvidia/bge-m3` as the measured miss. Positive signals only.
2. `menu/catalog.mjs` — carry the value as **`outputKind`**, not `kind`; `null` at the testModel site,
   `"text"` at the relay site, consistent with T2 step 2.
3. `menu/snapshot.mjs` — add **`outputKind`** to the model literal. **Breaks
   `test/snapshot.test.mjs:39`'s exact-key assertion by design**; update it.

**The menu-pipeline field is named `outputKind` from birth, here, and never renamed later.** `item.kind`
is already `"model" | "provider" | "pinned"` in `pick-state.mjs`, so `item.model.kind` would put two
unrelated vocabularies in one expression — and T4 adds `routable` as a second per-model status field
on the same object. Naming it at T5 instead, as R4 had it, would be a live defect and not a tidiness
point: T4 serializes the field, bumps the schema and **rebuilds**, and `menu/snapshot.mjs:53`
validates only `schemaVersion` and `Array.isArray(rows)` — so the T4-built file loads cleanly
carrying `kind`, T5's `isSelectable` reads `undefined === "nontext"`, **every non-chat row stays
selectable and the dim never fires**, while T5's fixture-driven acceptance stays green. A task
shipping nothing while reporting success is driver 3's vacuity, and the same
silently-degraded-artifact mechanism §1.10 spends five breaks documenting.

**keysync's row field stays `kind`** (T7 step 4): that object has no competing `kind`, V5 reads it
there, and it never reaches the snapshot. Say in both comments that they are the same value under
different local pressure.

**Acceptance:** `"nontext"` for the four §1.2 fixtures and `["embedding","text"]`; `"text"` for
`orcarouter/auto` (`input: ["image","text"] / output: ["text"]`); `null` for an entry with no
`modalities`.

---

### T4 — Wire up routability: five breaks, one schema bump, one rebuild *(catalogue lane — NEW in R3)*

**Depends on:** T3. **Independent of the declaration lane.**
**Files:** `menu/catalog.mjs`, `menu/snapshot.mjs`, `test/catalog.test.mjs`, `test/snapshot.test.mjs`.

Reuses everything: `routableSet`, `makeRoutableOf`, `routableFromConfig` and the
`m.routable === false` dim at `style.mjs:358` are all already written and tested. **Nothing new is
designed here — the wires are connected and one false comment is corrected.** Fix all five (§1.10)
or the gap persists.

1. **B1 — `build()` requests routability.** Give `build()` an optional `routableOf` parameter passed
   through to `buildFrom`, and have `menu/snapshot.mjs:main()` — which is **already `async`** — await
   `routableSet()` and pass `makeRoutableOf(set, fresh)`.
   **`build()` stays synchronous.** That is not incidental: `test/uwpick.test.mjs:119` asserts
   uwpick.mjs never calls `routableSet`, and `menu/catalog.mjs:112-127` explains that the picker's
   blocking `readSync` loop never drains the microtask queue, so a promise in that path is
   unreachable by construction. The fetch belongs to the refresher; keeping `build()` sync is what
   keeps it there.
   **Extend the existing dynamic import; do not add a static one.** `menu/snapshot.mjs:75` reaches
   `build()` through `const { build } = await import("./catalog.mjs")` deliberately, because
   `snapshot.mjs` is inside uwpick's transitive import graph and `catalog.mjs` pulls in
   `keysync.mjs`. A top-level `import { routableSet }` would compile, pass every test, and quietly
   move both modules into the picker's graph — invalidating the line-budget test's definition of its
   own scope (standing constraint 25, `plans/phase6-menu-and-catalogue.md:44`). Destructure
   `routableSet` and `makeRoutableOf` from the same `await import`.
2. **B2 — `buildSnapshot` carries `routable`.** Add it to the model literal at `:29-32`.
3. **B3 — `buildSnapshot` writes `routableAsOf`.** A top-level ISO stamp when `fresh`, `null`
   otherwise. `uwpick.mjs:56` and `style.mjs:269-271` already read and render it; this is the
   disclosure that `menu/catalog.mjs:122-126` says must exist and never did.
4. **B4 — update `test/snapshot.test.mjs:39`** to include `routable` (and `kind` from T3). Note in the
   test comment that the previous key list certified the drop.
5. **B5 — fix the comment that names a module that does not exist.** `menu/catalog.mjs:107-110`
   asserts `routableSet` "has exactly one caller, `refresh/cli.mjs`". Replace with the real caller
   (`menu/snapshot.mjs:main()`, the `--build` path) and one sentence recording that the planned
   `refresh/` module was never built and that this comment is why nobody noticed
   (`plans/phase6-menu-and-catalogue.md:289`).
6. **The degraded path must announce itself, and the budget must be a number.** Raise `routableSet`'s
   budget for the build path — the caller already parses a 19.7 MB catalogue, so 400 ms is sized for
   a path that does not exist. **Pass `timeoutMs: 5000` explicitly from `main()`**, not by changing
   the default: 400 ms stays correct for any future latency-budgeted caller, and 5,000 ms is chosen
   as the same order as `run.mjs`'s other deliberate non-interactive waits while staying well under
   the catalogue parse it sits beside — pin it with that reasoning in the comment, since this is the
   one step whose entire purpose is that a silent timeout reproduces the bug.
   On `fresh: false`, `main()` prints a distinct line naming the consequence — *"gateway did not
   answer within Nms; routability is unknown for all N rows and the header stamp will show a dash"*.
7. **The `fresh: true` but empty-set case needs its own line.** If CCR answers with no providers,
   `makeRoutableOf(set, true)` returns `false` for all 1,588 rows: every row dims, the stamp claims
   freshness, and the picker reads as totally broken. That is a *different* failure from the gateway
   being unreachable and §5's "not a validation rule, deliberately" covers only `fresh: false`.
   `main()` prints its own line when `fresh && set.size === 0` — *"gateway answered with no routable
   providers; every row will render dimmed"* — and still writes the snapshot, because the reading is
   accurate and refusing to build leaves the picker with no input at all.
8. **Bump `SNAPSHOT_SCHEMA` 1 → 2 here**, covering T2's meaning change plus T3's `kind` plus this
   task's two fields, and **rebuild the snapshot as part of this task**. There are two consumers and
   the second fails silently: `menu/hud-shim.mjs:93-94` calls `loadSnapshot()` and returns `null` on
   `!snap.ok`, losing the HUD context readout with no message, where uwpick prints an actionable line.
   `contextIndex` reads only `m.ctx`, so `routable` does not otherwise affect the HUD.
9. **No selector change** (D9-A). `style.mjs:358`'s dim is the whole rendering fix, and it already
   exists. Add the D9 comment beside it in Principle 6's terms: an image model cannot answer a chat
   request under any configuration, so it may be blocked; a row CCR did not list at snapshot time may
   be routable now, so it may only be dimmed.

**Accept, in writing, that this dims most of the screen.** ~1,497 of 1,588 rows will render dimmed.
At that ratio the dim stops signalling "exceptional" and the undimmed ~6% becomes the figure. That is
not an argument against T4 — the current state shows 1,588 undimmed rows of which ~94% error on
selection, which is strictly worse — but it is a rendering consequence no decision record contained,
and T9 step 5 will surface it whether or not it is written down. **If the reviewer at T9 judges it
unreadable, the remedy is one line in the same place**: invert the emphasis, rendering the routable
set in normal weight and everything else in the base colour, rather than dimming the majority.
Deliberately not pre-decided here — it is a judgement that needs the rendered screen.

**Acceptance criteria — gateway-free:**
- `build({routableOf: () => true})` and `build({routableOf: () => false})` each thread the predicate
  to every row, including both synthetic sites.
- `buildSnapshot` preserves `routable` through serialization for **both** `true` and `false`, and
  writes `routableAsOf`. This is the pair that catches B2 and B3 without a live gateway, and it is
  the assertion `test/snapshot.test.mjs:39` previously forbade.
- With a stubbed `rpc` returning `null`, `main()` still writes a valid snapshot, every `routable` is
  `null`, `routableAsOf` is `null`, and **the degraded line is printed**.
- With a stubbed `rpc` returning `{Providers: []}`, the empty-set line is printed and the snapshot is
  still written.
- `menu/uwpick.mjs` still contains no reference to `routableSet` (`test/uwpick.test.mjs:119` stays
  green); `build()` is still not `async`; `menu/snapshot.mjs` still has no static import of
  `catalog.mjs`.
- **No comment in `menu/` names `refresh/cli.mjs` or any other unbuilt module** (B5).
- The HUD context readout still renders after the bump and rebuild.

**Acceptance criteria — gateway-dependent, deferred to T9 step 5:** that the values are *not uniform*
on live data. R3 put this here, where CCR being down makes it fail indistinguishably from a broken
build — on the very path step 6 exists to handle. `node --test` must stay green without a gateway.

---

### T5 — Piece 2b: render dimmed, skip in the selector *(catalogue lane)*

**Depends on:** T4. **Files:** `menu/pick-state.mjs`, `menu/style.mjs`, `test/uwpick.test.mjs`,
`test/pick-state.test.mjs`, **`test/style.test.mjs`** (the real width guards — see §4.3).

The cursor reaches a row **six** ways. R1 missed the pinned path, which is the one that affects
existing users.

1. `export function isSelectable(item)` — `false` only when
   `item.kind === "model" && item.model.outputKind === "nontext"`. Providers and `outputKind: null`
   are selectable (the decided default). **`routable === false` is deliberately not here** — D9-A and
   Principle 6; say so in the comment, since the neighbouring dim makes the omission look like an
   oversight.
2. **The pinned path.** `menu/uwpick.mjs:155` → `loadPickerState()` (`menu/state.mjs:25-31`) returns
   recents and favourites as **plain target strings**. `initState` turns them into
   `{kind: "pinned", target, mark}` — **no `model` object**, so the per-model field is absent by
   construction and `isSelectable` reads them as selectable. Anyone who has ever selected
   `nscale/flux.1-schnell` has it in recents and enter still switches. **Fix at the existing seam:**
   `initState` already filters pins to `known.has(t)` (`:13-19`) precisely so a pin naming a dropped
   model is not a dead selection. Build `known` from *selectable* models only — one line, consistent
   with the rule already stated in that comment.
   **This is a hide, under a "show, never hide" principle, and the tension must be named rather than
   left for a reader to find.** Principle 4 governs the *model list*: the row itself still renders in
   the tree, dimmed, with its modality. What is dropped is a *duplicate shortcut* to a row that is
   already visible and already unselectable — and `initState:15-16` already establishes exactly this
   rule for a pin naming a model the catalogue dropped. A pin whose only possible action is refusal
   is not information; it is a dead control. Say that in the comment.
3. `export function nextSelectable(list, from, dir)` — nearest selectable in `dir`, wrapping,
   **returning `from` when nothing is selectable**. Reachable today: filter `flux` in flat scope leaves
   **5** rows in the snapshot, all `output: ["image"]` (R1 said 2 — the conclusion holds and is better
   supported). Without the guard this is an infinite loop in a blocking `readSync` with no event loop
   to interrupt it.
4. Wire it at all five in-session sites: arrows (`:152-169`), `reset()` (`:80-85`), `clamp()`
   (`:68-78`), enter (`:181-189`, refuse), ctrl+f (`:148-150`, refuse — a favourite is a target the
   user intends to switch to).
   **Two ordering hazards inside `clamp`, both from R1 and neither yet written down:**
   - `clamp` derives `top` from `cur` (`:74-76`). The selectable-pull must run **before** that
     arithmetic, or `top` is computed from the pre-correction index and the viewport scrolls to a row
     the cursor is no longer on.
   - On the arrow path, `reduce` computes the next index and *then* calls `clamp`, so a naive
     implementation corrects twice — `nextSelectable` steps over a non-chat row, then `clamp` steps
     again — and a single keypress moves two rows. Either `clamp`'s pull must be idempotent on an
     already-selectable index (it is, if written as "if not selectable, advance"), or the arrow path
     must skip it. Assert the single-step property directly; it is invisible to any test that only
     checks the cursor ended somewhere selectable.
5. `menu/style.mjs` — dim when `m.outputKind === "nontext"`, and render the modality label in the
   `ctx` cell at the call site `:350` (D2-A). A row that is both non-chat and non-routable dims once;
   the modality label and the header stamp still distinguish the reasons.

**Acceptance criteria:**
- A non-chat row appears in `view().items` — shown, never hidden.
- Arrows step over it both ways; a filter landing on one moves off; enter → state unchanged,
  `exit: null`; ctrl+f → `favourite: null`.
- **A recents file containing `nscale/flux.1-schnell` produces no pinned row**, and a chat-model pin
  still works.
- **A `routable: false` row is dimmed and remains fully selectable** — the D9-A assertion, and the
  test that stops someone folding it into `isSelectable` later.
- **One arrow keypress moves exactly one selectable row**, and the viewport (`top`) follows the
  corrected cursor, not the pre-correction one.
- A list whose every item is non-chat terminates and leaves the cursor put.

---

### T6 — Piece 3a: plumb capability signals to the write site *(declaration lane, 83 rows)*

**Files:** `keysync/keysync.mjs`, `test/denylist.test.mjs`.

1. Widen both normalization pushes. **The field is `contextTokens`, not `ctx`** (§1.4):
   - `:353-357` — `reason: cat?.capabilities?.reasoning ?? null, kind: outputKind(cat)`. `cat`
     undefined → both `null`. Comment: the 38-row case, and why D3 exists.
   - `:367-369` — `reason: m.capabilities?.reasoning ?? null, kind: outputKind(m)`.
2. `contextTokens` keeps `0` as-is (`google/lyria`); `bucketFor` treats non-positive as no signal.

**Acceptance:** a fixture-driven test asserts the normalized objects carry the three fields with the
right tri-state, and a no-entry testModel row carries `null` — **not `false`**. `?? null`, never `||`
(boundary 2). The test asserts on the **object the pipeline produced**, so the field name is checked
rather than assumed.

---

### T7 — Piece 3b: the bucket table and the classifier *(declaration lane)*

**Depends on:** T1 (§1.9), T6. **Files:** `keysync/keysync.mjs`, `test/denylist.test.mjs`.

1. Constants, frozen, commented with the evidence:
   ```
   BUCKET_TARGETS = { capable: "claude-sonnet-4-6",
                      weak:    "claude-sonnet-4-5",
                      unknown: "claude-sonnet-4-5",   // D3 — same target, distinct classification
                      nonchat: "claude-sonnet-4-5" }  // D6 — inert but never absent
   ALLOWED_BEHAVES_AS   = ["claude-sonnet-4-6","claude-sonnet-4-5","claude-opus-4-6","claude-opus-4-1"]
   PROMPT_BUNDLE_MODELS = /^claude-(opus-5|fable-5|mythos-5)/
   CTX_CAPABLE_MIN      = 128000
   ```
   - `capable` stays `claude-sonnet-4-6` — unchanged from today, which makes 32.5% a zero diff and
     proves the classifier ran rather than replaced.
   - `weak` is `claude-sonnet-4-5`, **not** the capability-identical `claude-haiku-4-5`: report 18
     §10.2 fn 1 — haiku's `interleaved_thinking` flips false on `bedrock`/`vertex`/`gateway`/custom
     base URL, i.e. exactly UW's provider shapes. `haiku-4-5` is deliberately absent from the
     allowlist for the same reason.
   - `PROMPT_BUNDLE_MODELS` names why: `opus_5_prompt_bundle`, `fable_5_mitigations`,
     `refusal_fallback`, `thinking_disabled_effort_cap`, `rejects_disabled_thinking` (§10.3), plus
     that these models omit `temperature` entirely (§10.2).
2. `export function bucketFor(model)` taking the **keysync normalized shape**
   `{kind, reason, contextTokens}` → `"nonchat" | "capable" | "weak" | "unknown"`:
   ```
   kind === "nontext"   -> "nonchat"
   reason === true      -> "capable"
   reason === false     -> "weak"
   typeof contextTokens === "number" && contextTokens > 0
     ? (contextTokens >= CTX_CAPABLE_MIN ? "capable" : "weak")
     : "unknown"
   ```
   `"unknown"` is a distinct return, not a synonym for `"weak"` — that is what makes the `> 0` guard
   observable (boundary 3) and lets the audit count no-signal rows. `contextTokens > 0` is not
   padding: `google/lyria` really reports `0`.
3. `export function behavesAsFor(model)` → `BUCKET_TARGETS[bucketFor(model)]`. Never returns
   `null`/`undefined` — D6.
4. Replace `:419`'s `row.behavesAs = BEHAVES_AS` with `behavesAsFor(m)`; carry `kind` onto the row so
   `validate()` can see it (D8-A). Delete the now-false `:117-120` comment and the `UW_BEHAVES_AS`
   constant (D7-A), after grep-confirming `:120` is its only reader.
5. **Extend the strip at `run.mjs:869` to `({contextTokens, kind, ...row})` in this commit**, not in
   T8. The task that adds the field is the task that strips it: §2 makes a post-T7 commit a
   legitimate stopping point, and between a T7 that adds `kind` and a T8 that removes it, a
   `--target live` run writes a fifth key into a file whose zod schema is exactly four (§1.8(4)),
   with V8 not yet existing to catch it. R4 had this as T8 step 2, leaving the same kind of window
   R1 carried a HAZARD box for before T1.

**Acceptance criteria:**
- `bucketFor` matches the full decision table, including the ordering and boundary cases in §4.2.
- **One test drives `bucketFor` with an object the pipeline built**, not a literal (§1.4).
- End-to-end from a fixture catalogue: 4 nonchat / 27 capable / 14 weak / 38 unknown; 27 rows at
  `claude-sonnet-4-6`, 56 at `claude-sonnet-4-5`. **The end-to-end assertion runs the built picker
  through `orderNativePickerOptions`** (§1.9 measure 2) — as R3 wrote it, this criterion passed
  identically with or without T1, which is the vacuity §1.9 exists to name.

  **Two separate jobs, do not conflate them** (found at T1 execution). Routing through
  `orderNativePickerOptions` is an *ordering interlock*: pre-T1 the function filters, so the
  distribution assertion fails and T7 cannot land without T1. Post-T1 the function is a
  pass-through, so "count the rows that survive" is `input.length` by construction and proves
  nothing about bucketing. **T7 must assert the 27/56 distribution over the returned array on its
  own terms** — the routing is what orders the tasks, not what checks the classifier.
- Every row has a `behavesAs`. None is `null`, `""`, `claude-haiku-4-5`, or matches
  `PROMPT_BUNDLE_MODELS`. `grep -r UW_BEHAVES_AS` returns nothing.

---

### T8 — Two-tier validation *(declaration lane)*

**Files:** `keysync/keysync.mjs` (`validate`), `keysync/run.mjs`, `test/denylist.test.mjs`.

1. V1-V6 into the existing `problems[]` in `validate()`, which `run.mjs:509-513` already turns into
   `VALIDATION FAILED` + `exit 1`.
2. *(The `:869` strip extension moved into T7 step 5 — the task that adds `kind` strips it, so no
   commit between them can write a fifth key. V8 below still pins the property.)*
3. `export function assertOptionsComplete(builtPicker, writtenOptions)` in `keysync/run.mjs`, called
   **after** the `settings.modelPicker` assignment at `:868-871` and before `atomicWriteJson` at
   `:878`, as `assertOptionsComplete(built.picker, settings.modelPicker.options)`. Throws; the
   **existing** catch at `:891` restores settings.json from backup. Enforces V7-V8.
   **The argument must be the post-strip array.** `optionRows` at `:867` still carries
   `contextTokens` (set at `keysync.mjs:420`) and, after T7 step 4, `kind` — so handing it to V8
   would fire on every row of every clean build and roll settings.json back. `model` survives the
   strip, so the written array serves both rules: V7 compares presence on `model`, V8 checks the key
   set of exactly what will be written. R3 named `optionRows` in three places; all are corrected.

**Acceptance:** one test per rule, each asserting the message *names the reason*, not merely
`problems.length > 0`. **A clean build gives `problems === []` and `assertOptionsComplete` returning
normally** — the criterion R3 made unsatisfiable. A build whose written options have been filtered
throws. This does **not** order T1 and T7 (§1.9); what it does is make T1 permanent once landed.

---

### T9 — Live verification and diff audit

1. `node --test "test/*.test.mjs"` — ≥355 pass, 0 fail.
2. `node keysync/run.mjs` dry. A provider losing all its models is a finding worth stopping for
   (`keysync.mjs:336-339`).
3. `--target live`, then diff against `keysync/behaves-as-before.json`. **Assert properties, not
   constants** — the Anthropic row count comes from the live catalogue and is not fixed at 4 (§1.2a).
   Let `A` = the Anthropic row count the build's own log reports:
   - **`options.length === built.picker.length`** — nothing was filtered. (A count of `A` alone means
     T1 regressed; T8's `assertOptionsComplete` should have caught it first.)
   - **indices `0..A-1` are exactly the `anthropic/` rows; no `anthropic/` row at index ≥ `A`.**
   - **third-party order preserved on the set intersection** with the baseline — compare only targets
     present in both, since the catalogue may legitimately have gained or lost rows.
   - exactly **27** targets byte-identical at `claude-sonnet-4-6`; every other reads
     `claude-sonnet-4-5`. **No target lacks `behavesAs`** (D6). No `claude-opus-5`,
     `claude-fable-5*`, `claude-haiku-4-5`, or empty string anywhere.
   - every written row's keys ⊆ `{model, label, description, behavesAs}` — no `kind`, no
     `contextTokens`.
4. Launch Claude Code, open `/model`: Anthropic rows at the top; **no unknown-model warning for any
   third-party row, including the four non-chat rows** (satisfiable only because of D6).
5. Open the picker. Assert **properties, not counts** — the routable set is gateway state and will
   drift:
   - the header shows `routable <date>`, not a dash (B3 fixed);
   - **the routable values are not uniform on live data** — at least one `true` and at least one
     `false`. Moved here from T4, where it required a running gateway inside `node --test`;
   - **both dim classes are present and behave differently**: at least one `routable: false` row is
     dimmed *and still selectable*, and the four non-chat rows are dimmed *and skipped*. This is the
     live D9 assertion, and the one step that would catch someone having quietly folded `routable`
     into `isSelectable`;
   - **judge the ~94% dim ratio on the rendered screen** (T4's accepted consequence). If it reads as
     unusable rather than informative, invert the emphasis at `style.mjs:358` — normal weight for the
     routable set, base colour for the rest — rather than reverting T4;
   - the four non-chat rows show their modality in the `ctx` cell;
   - a pre-existing non-chat entry in recents produces no pinned row.

---

## 3. Exported pure functions

Following `checkBareCollisions` / `deriveAnthropicSets` (`keysync/run.mjs:71`, `:272`) — the pipeline
cannot be driven from a test, so logic left inline is logic nothing can assert on.

| function | module | signature | why extracted |
|---|---|---|---|
| `orderNativePickerOptions` | `keysync/run.mjs` | `(rows, opts) → rows` | replaces `scopeNativePickerOptions`; keeps a tested seam rather than deleting one |
| `assertOptionsComplete` | `keysync/run.mjs` | `(builtPicker, writtenOptions) → void \| throws` | the only place V7/V8's subject exists (D8). **Second argument is the post-strip `settings.modelPicker.options`, not `optionRows`** |
| `capsOf` | `menu/catalog.mjs` | `(entry) → {tools, vision, reason}` tri-state | one place owns the null rule; reused by the synthetic-row audit |
| `outputKind` | `keysync/keysync.mjs` | `(entry) → "text"\|"nontext"\|null` | needed by both lanes; `catalog.mjs` already imports keysync as `K` |
| `isSelectable` | `menu/pick-state.mjs` | `(item) → boolean` | one predicate, **five call sites plus one upstream filter** — after T5 step 2 the pinned path is handled in `initState`'s `known` set, not by a sixth call. Divergence between the five is the likely defect |
| `nextSelectable` | `menu/pick-state.mjs` | `(list, from, dir) → index` | owns the no-selectable-item termination guard |
| `bucketFor` | `keysync/keysync.mjs` | `({kind, reason, contextTokens}) → classification` | the whole classification decision, testable without the vault |
| `behavesAsFor` | `keysync/keysync.mjs` | `(model) → string` | the table lookup, so the table cannot be bypassed |

**Already exported, reused unchanged by T4:** `routableSet`, `makeRoutableOf`
(`menu/catalog.mjs:128`, `:143`), `routableFromConfig` (`menu/ccr-client.mjs:178`). T4 adds no new
function — it connects existing wires and corrects the comment that hid the gap (§1.10).

---

## 4. Test plan

### 4.1 New and rewritten tests by task

**T1 — the four tests at `test/denylist.test.mjs:973-1022` are rewritten.**

| current | disposition |
|---|---|
| `:973` "only the Anthropic rows are written" | **Inverted** → *"every built row is written, Anthropic first"*. All 7 fixture rows; indices 0-3 Anthropic; the 3 third-party rows in original relative order. |
| `:986` "returns a NEW array and leaves the caller's rows exactly as built" | **Kept, comment strengthened** — now guards D5-C's rejected in-place sort, which would repoint `built.picker[0].model` at `run.mjs:681`. Drop the trailing `description` assertion, which encoded the 4-row shape. |
| `:999` "with the relay DOWN the full built set is written" | **Rewritten as an ordering edge case** → *"with no Anthropic rows the input is returned unchanged and in order"*. |
| `:1011` "the scoped rows and the routable providers are deliberately different sets" | **Replaced by its inverse** → *"every built row reaches `options[]`, because `options[]` is the only channel that can carry `behavesAs`"*. Assert `dropped.length === 0`, cite §1.8(2). The old test stopped a future un-scoping; this one stops a future re-scoping. |

**T2 —** `capsOf` returns `null` for an absent key and preserves `false` for a present one (the whole
bug in one assertion). `buildFrom` over a fixture with `capabilities: {}` and `{reasoning: false}`.
Synthetic rows: testModel `null`, relay `true`. Three distinct glyphs.

**T3 —** `outputKind` over the four fixtures, `orcarouter/auto`, `["embedding","text"]`, and a
`modalities`-less entry. Snapshot key set gains `kind`.

**T4 — every item here is gateway-free.** (a) `build({routableOf})` threads the predicate to every
row, including both synthetic sites, for `() => true` and `() => false`; (b) `buildSnapshot`
preserves `routable` through serialization **for both values** — this is the assertion
`test/snapshot.test.mjs:39` previously forbade, and its comment should say so; (c) `buildSnapshot`
writes `routableAsOf` when fresh and `null` when not; (d) a stubbed `rpc` returning `null` yields all
`null` and prints the degraded line; (e) a stubbed `rpc` returning `{Providers: []}` prints the
empty-set line and still writes; (f) `build()` is not `async`, `menu/uwpick.mjs` contains no
`routableSet` reference, `menu/snapshot.mjs` has no static import of `catalog.mjs`; (g) no comment
under `menu/` names `refresh/cli.mjs` (B5).

**T5 —** the five in-session paths; the **pinned path** (a recents file containing
`nscale/flux.1-schnell` yields no pinned row, while a chat-model pin survives); **a `routable: false`
row is dimmed and still selectable** (D9-A); the all-non-selectable list terminates; the row still
appears in `view().items`; the frame dims it and shows its modality.

**T6 —** normalized objects carry `reason`/`kind`; a no-entry testModel carries `null`, not `false`.

**T7 —** the complete decision table; `contextTokens: 0`; `contextTokens: undefined`; `reason: false`
with a large context (reasoning wins); `kind: "nontext"` with `reason: true` (non-chat wins);
**one test driving `bucketFor` with a pipeline-produced object**; end-to-end distribution.

**T8 —** one test per V-rule; `assertOptionsComplete` throws on a filtered `optionRows` and returns
normally on a complete one.

### 4.2 Mutation boundaries

House practice (`test/denylist.test.mjs:592`, `:671`, `:796`): name the one-character change a test
exists to catch. Seven boundaries, each leaving every *other* test green.

1. **`contextTokens >= CTX_CAPABLE_MIN` → `>`.** `cerebras/llama3.1-8b` sits at exactly 128,000 and
   flips to weak. Same form as the `ONE_M_TOKENS` boundary at `:796-808` — assert 127,999 / 128,000 /
   128,001.
2. **`?? null` → `|| null` in `capsOf` and T6's plumbing.** `false || null === null`, so a
   known-false capability silently becomes unknown — the original `!!` bug wearing a different
   operator. Invisible to any test that only checks the unknown case, so the assertion must be on
   `false`.
3. **`contextTokens > 0` → `!= null` in `bucketFor`.** `google/lyria`'s `0` becomes a valid tiny
   context. **This boundary was unfalsifiable in R1** — with both branches returning `"weak"`,
   original and mutant were identical on every input the Critic tested
   (`{0,-1,4096,8192,128000,131072,undefined,null}`), so the plan mandated a comment calling an inert
   guard load-bearing. **D3's distinct `"unknown"` return fixes it**: `bucketFor({kind: null,
   reason: null, contextTokens: 0})` is `"unknown"` under the guard and `"weak"` without it. Assert
   that directly, bypassing the `kind` shadow.
4. **Reordering `reason` above `kind` in `bucketFor`.** `google/lyria` and `google/veo-2` both have
   `reasoning: false`, so both land in weak instead of nonchat — and every §1.2 count still sums to
   83. Assert with a row that is `kind: "nontext"` and `reason: true` simultaneously.
5. **Deleting the empty-list guard in `nextSelectable`.** Nothing else fails; the process hangs, and a
   hang inside `readSync` on `//./CONIN$` cannot be interrupted.
6. **Restoring the filter — `assertOptionsComplete`'s subject.** Changing
   `orderNativePickerOptions`'s second partition half to `[]`, *or* re-adding a `.filter()` at
   `run.mjs:867`. R1 placed this against `validate()`, which runs 362 lines before `optionRows` exists
   and is blind to the write site. With D8-A the seam is real: the rewritten `:1011` test catches the
   function, `assertOptionsComplete` catches the call site.
7. **Dropping `routable` from `buildSnapshot`'s model literal (NEW).** This is not hypothetical — it is
   **the exact state of the code today** (B2), and it survived because `test/snapshot.test.mjs:39`
   asserted the key set *without* it. The assertion that must catch it is a positive one: the field
   survives serialization carrying the value it was given. A key-set test alone would pass a snapshot
   where every `routable` is `undefined`, which is how B2 hid for as long as it did. **Same argument
   applies to `routableAsOf` (B3).**
   **Run it gateway-free:** `buildSnapshot(build({routableOf: () => true}))` and the `() => false`
   twin, asserting the value round-trips both ways. R3 specified "values are not uniform on live
   data," which cannot be executed without CCR running — and on the very path T4 step 6 exists to
   handle, an unreachable gateway would make the check fail indistinguishably from a broken build.
   `node --test` must stay green with no gateway. The live non-uniformity check moves to T9 step 5.

Method: apply each by hand, confirm the named test fails and the suite is otherwise green, revert.
Record in the commit message as prior work did.

### 4.3 Regression surface

`test/snapshot.test.mjs:39` (exact key set) intentionally breaks at T3 and again at T4. The
line-budget and three-frame motion tests in `test/uwpick.test.mjs` gate T5. The four
`scopeNativePickerOptions` tests break at T1 **by design**. `test/uwpick.test.mjs:119` (uwpick never
calls `routableSet`) must stay green through T4 — it is the constraint that keeps `build()`
synchronous.

**The real width guards, and they gate T2 and T5.** R1 named `test/menu-layout.test.mjs`, which is
three tests about file locations and exports with no width assertions (§8 C4) — but R2-R4 then
generalized that correction into "no width assertions anywhere", which is also wrong.
**`test/style.test.mjs` holds three, and one was written about the exact cell this plan makes
polymorphic:**

- `:164` *"every column begins where the W constants say it begins"* — derived from `W` rather than
  transcribed, and it **names the column** on failure.
- `:238` *"every line of every frame is exactly `FRAME_W` visible columns"* — across four view states
  and both capability sets. This is the assertion R4 offered to write; it exists.
- `:409` *"the context column never overflows, so the unit is never the thing clipped"* — written
  after `ctxS` emitted `1.048576M` into a six-wide column and `bar()` clipped the `M`, rendering a
  1,048,576-token window as `1.0485`. **D2-A puts `AUDIO`/`VIDEO`/`IMAGE` into that same cell**, so
  this test is the one that will catch a modality label that does not fit, and T5 step 5 must extend
  its cases rather than route around it.

So T2's tri-state glyph and T5's polymorphic `ctx` cell are both genuinely guarded. D2-C's rejection
is unaffected — it stands on the sufficient reason that a glyph cannot name *which* modality.

**Known ambiguity left in place:** `spike/uwmodels-web.mjs:243` renders `m.tools?'T':'-'` — a third
renderer keeping the false/null conflation after T2. Deregistered spike file, out of scope; recorded
so the inconsistency is deliberate rather than missed.

---

## 5. Validation rules, in two tiers

**Tier 1 — `validate({providers, picker})`, `run.mjs:505`, subject = the built set.**

| # | rule | message shape |
|---|---|---|
| V1 | every value in `BUCKET_TARGETS` ∈ `ALLOWED_BEHAVES_AS` | `bucket "weak" target "X" is not in ALLOWED_BEHAVES_AS — a vetted target, not a typo` |
| V2 | no bucket target matches `PROMPT_BUNDLE_MODELS` | `bucket target "X" carries a model-specific prompt bundle (report 18 §10.3) and must never be inherited by a third-party model` |
| V3 | every non-relay picker row **has** a `behavesAs`, and it is one of `BUCKET_TARGETS`' values | `picker row "p/m" has behavesAs "X", which is not a bucket target` |
| V4 | `picker[].model` unique across the array | `duplicate picker row "p/m"` — report 19 §6.3 |
| V5 | a row with `kind === "nontext"` carries the **weak** target (D6-A; inverted from R1) | `non-chat row "p/m" declares "X"; a non-chat row must declare the weak target — omitting it resolves to the maximal assumption set (report 18 §3)` |
| V6 | **the whole table shape**: `capable` maps to the capable target, and `weak`, `unknown` and `nonchat` all map to the weak target — asserted as a set, not as one inequality | `BUCKET_TARGETS.unknown points at the capable target; only "capable" may` |

V6 is the canary for the failure that looks like success. **R3 wrote it as
`capable !== weak`, which guards one of three ways the table can break**: setting `unknown` or
`nonchat` to the capable target flips 38 or 4 rows into over-declaration with `capable !== weak`
still true and every other rule green. `BUCKET_TARGETS` has four keys; the invariant is over all
four. It is checkable at all only because D7-A retired the whole-table env override that would
otherwise have made it fire on every legitimate use.

**Tier 2 — `assertOptionsComplete(built.picker, settings.modelPicker.options)`, called after the
`modelPicker` assignment and before `atomicWriteJson` at `:878`; subject = the written artifact.**
Not `optionRows` from `:867`, which is pre-strip — see T8 step 3.

| # | rule | message shape |
|---|---|---|
| V7 | every built row appears in `optionRows` | `N built row(s) did not reach modelPicker.options (first: "p/m") — options[] is the only channel that can carry behavesAs; lH() resolves a missing declaration to the maximal assumption set (report 18 §3, OQ-1)` |
| V8 | every written row's key set ⊆ `{model, label, description, behavesAs}` | `row "p/m" would write key "kind", which is not in Claude Code's row schema (§1.8(4))` |

Both throw into the existing catch at `run.mjs:891`, which restores settings.json from backup.

**Not validation rules, deliberately:** T4's two degraded cases print and proceed rather than failing.
A snapshot with unknown routability is honest and usable (`null` renders undimmed by design), and one
where the gateway genuinely serves nothing is an accurate reading; a build that refuses to produce
either leaves the picker with no input at all. The announcement is the control; failing would be the
overreaction. The two cases print *different* lines because they are different facts —
`fresh: false` means nobody answered, `fresh && set.size === 0` means someone answered "nothing" —
and R3 covered only the first.

---

## 6. Open questions

Tracked in `plans/open-questions.md`.

- **OQ-1 — RESOLVED.** §1.8. Decision 4 reversed; T1 added; T1 ⇒ T7.
- **OQ-2 — RESOLVED, and not an artifact.** Nothing would supply `behavesAs`; that is why the reversal
  happened. Closed by T1, kept closed by V7.
- **OQ-3 — OPEN.** `nvidia/bge-m3` is an embedding model the catalogue declares `output: ["text"]`.
  Confirms `modalities.output` is positive-signal-only. Upstream note to CCR; out of scope.
- **OQ-4 — CLOSED BY SCOPE CHANGE, now T4.** Was "the routable dimming is inert." Investigation found
  five independent breaks rather than a stale build (§1.10). Folded into this plan at the user's
  direction, because report 17's decided two-keystroke `/autocompact` flow consumes the same snapshot
  and should not be built on an artifact whose routability field is absent.

---

## 7. Scope — corrected

R1 said "83 of 1,588" and left the reader to infer this branch covers 5% of the catalogue. **Measured
against the live gateway: CCR routes 91 models across 45 providers** (83 third-party + 8 relay),
per-provider histogram `{1:23, 2:3, 3:18, 8:1}` — the same spread as the picker rows.
`routableFromConfig` (`menu/ccr-client.mjs:178`) builds the routable set from `Providers[].models`,
which comes from the same capped array the picker rows do.

**So 83 is not 5% of usable models. It is 100% of routable third-party models.** You cannot declare a
capability profile for a model you cannot route to; the declaration channel and the routing config are
the same set by construction.

**The 1,588-model snapshot is a browsing surface, and the catalogue lane covers all of it.** T2, T3,
T4 and T5 are catalogue-wide; only T1, T6, T7 and T8 are 83-scope. T4 sharpens the relationship
between the two numbers rather than blurring it: after T4, the picker *discloses* which of its 1,588
rows are among the 91 CCR can route, which is the same set the declaration lane describes. The two
lanes meet at that number.

**Why 83 and not more — stated as a current fact, not as an endorsement.** The set is 83 because
`MAX_MODELS_PER_PROVIDER = 3` caps each provider's contribution, and `keysync.mjs:349-372` produces
`Providers[].models` and the picker rows **from one array**, so the cap sizes routing and declaration
together.

**The user has ruled that cap deprecated as a design** (2026-09-06). Both of its stated
justifications are moot: menu size, because uwpick is the real picker and the native menu is a
separate surface; and attack surface, because that is a real concern to be solved on its own terms
rather than by capping reach. The project's aim is to route as many working models as possible. Its
original rationale is recorded for provenance only — `keysync/phase6-design-notes.md:330-331`
(*"currently the only thing bounding both picker size and this attack surface"*) and standing
constraint 27 at `plans/phase6-menu-and-catalogue.md:46` (*"not lifted when any list becomes
remote"*) — and neither should be read here as a reason the cap is correct.

**None of that changes this branch.** 83 is today's complete routable set, which is what makes the
declaration channel and the routing config the same set; that claim is load-bearing and true
regardless of whether the cap should exist. Removal is a decided follow-up, tracked in
`plans/open-questions.md`.

**And T4 is a prerequisite for it — but not for the reason R4 gave.** R4 said widening "would put
hundreds of unverifiable rows in the picker." That is backwards: widening `MAX_MODELS_PER_PROVIDER`
widens `Providers[].models`, which is exactly what `routableFromConfig` reads, so it moves rows from
`routable: false` to `true` and **reduces** the dimmed count. It adds nothing to uwpick, which
already renders all 1,588. Where it adds rows is the **native `/model` menu**, which has no dimming
at all — so the real prerequisite relationship is that T4 gives uwpick the only surface capable of
distinguishing reachable from unreachable, and widening without it would grow the one surface that
cannot.

### Out of scope (explicit)

- **Any CCR change.** CCR strips `thinking`/`effort`/`output_config` for 44 of 45 providers; a blanket
  strip would break `deepseek` and `bigmodel`, which set their own.
- **Foundry / Vertex deployment-shape adoption** (report 18 §6).
- **Context window and compaction** — a separate, decided-but-not-started lane. T4 is a *prerequisite
  hygiene* fix for it, not an entry into it.
- **Cross-provider or fuzzy name matching**, in any form.
- **Live provider `/v1/models` capability fetching** (report 18 §9.6).
- **Lifting `MAX_MODELS_PER_PROVIDER`** — decided for a later branch, not this one; see
  `plans/open-questions.md`.
- **Making `routable` block selection** — D9-B, rejected on Principle 6.
- **A routability refresh on any path other than the snapshot build** — `test/uwpick.test.mjs:119` and
  `menu/catalog.mjs:112-127` establish why the picker cannot do it.
- **Menu length as a problem in its own right.** Decision 4's objection is real and now knowingly
  accepted as the price of the declaration channel. If revisited, the constraint to design against is
  §1.8(2), not aesthetics — and `availableModels`/`Gun()` is not an escape hatch, since it makes the
  model unusable as well as unlisted.

---

## 8. Revision 2 changelog (Architect + Critic review)

| # | change | why |
|---|---|---|
| **C1** | **D6 added; non-chat rows declare the weak target.** V5 inverted. | R1's omission was the *maximal* over-declaration (§1.8(3)), inverting Principle 3 in the one place the plan gave a single sentence. Both reviewers reached it independently. |
| **C2** | **D8 added; validation split in two; `assertOptionsComplete` introduced.** `kind` on the row; strip at `:869` extended; V8 added. | V5 and V7 were unimplementable: `validate()` sees neither `kind` nor `optionRows`. Relocating V7 gives boundary 6 a real seam. **(The "mechanically enforces T1 ⇒ T7" half of this entry is superseded by C24 — it was false. Kept as written so the changelog records what R2 claimed, not what R4 knows.)** |
| **C3** | **D7 added; `UW_BEHAVES_AS` retired.** | A whole-table override and V6 are mutually exclusive — the hatch would have failed the build on first use. |
| **C4** | **`test/menu-layout.test.mjs` claims withdrawn** (4 sites); D2-C re-rejected on its honest reason. | The file has no width assertions. An alternative was rejected on a false premise. |
| **C5** | **D5's fallback-deletion justification replaced.** | `run.mjs:385` is `--verified-only`-gated; the real guard is `:882-883`. The decision stands, the reason did not — and T1 step 6 makes shipping a false justification the defect to fix. |
| **C6** | **Snapshot rebuild mandated; `hud-shim.mjs:93-94` named.** *(R3 moved the bump and rebuild to T4 — see C15.)* | A second snapshot consumer fails *silently*. R1 justified the bump entirely via uwpick. |
| **C7** | **`bucketFor` takes `contextTokens`; a pipeline-object test mandated.** | `ctx` is the menu pipeline's name. Read literally, all 7 proxy rows would evaluate `undefined >= 128000` and 27/56 would silently become 24/59, with literal tests staying green. |
| **C8** | **`"unknown"` added as a distinct classification.** | Boundary 3 was unfalsifiable — both branches returned `"weak"`, so the plan mandated a comment calling an inert guard load-bearing. |
| **C9** | **T5 gains the pinned path (six sites, not five).** | Pins are persisted target *strings* with no model object, so `isSelectable` read them as selectable. The guarantee was false for any existing user with a non-chat model in recents. |
| **C10** | **T9 restated as properties; §1.2a's Anthropic zero-diff claim retracted.** | `pickerIds` comes from the live catalogue (`run.mjs:283-285`), so `87`/`79` are not invariants and Anthropic churn is not a T1 regression. |
| **C11** | **T1's ordering argument replaced; D5 notes the partition is a no-op today.** | T7-only is identical to HEAD, not worse. The real hazard is a **false green**. And `run.mjs:465`'s `unshift` already orders Anthropic first. |
| **C12** | **T0's premise corrected; baseline moved to `keysync/behaves-as-before.json`.** | Two runs destroy it, not one — but `safety.mjs:112`'s `.sort().reverse()` over two coexisting stamp formats makes retention unreliable, which is the better argument. And `research/phase6/_tmp/` is gitignored while T9 consumes it. |
| **C13** | **§7 rewritten.** | 83 is 100% of routable third-party models, not 5% of the catalogue; `MAX_MODELS_PER_PROVIDER` is a security control; the lane split was obscured. |
| **C14** | **Smaller:** 135 → 18 for the embedding clause; flux filter 2 → 5 rows; D2-A's `ctxS()` cost corrected to one call site; `spike/uwmodels-web.mjs:243` recorded; T1-as-standalone-commit stated. | Accuracy, and one structural suggestion §1.2a had gestured at and dropped. |

## 9. Revision 3 changelog (routability scope addition)

| # | change | why |
|---|---|---|
| **C15** | **T4 added; tasks renumbered T4→T5, T5→T6, T6→T7, T7→T8, T8→T9. The single schema bump and rebuild moved from T2 into T4.** | The routable wire-up touches `buildSnapshot`'s model literal and `test/snapshot.test.mjs:39` — the same two places T2 and T3 touch. Sequencing it last in the catalogue lane means the snapshot shape changes once, one bump, one rebuild, no mid-lane HUD outage. It does not lengthen the critical path (T1 → T7 → T8 → T9). |
| **C16** | **§1.10 replaces "the gateway was down at build time" with four measured breaks.** | The coordinator's premise was one of four, and fixing it alone would produce exactly today's artifact. `routable` is **absent**, not `null`: `build()` never passes `routableOf` (B1); `buildSnapshot` drops the field (B2); `routableAsOf` is never written, so the disclosure designed to expose this never existed (B3); and `test/snapshot.test.mjs:39` certifies the drop (B4). |
| **C17** | **D9 added — dim-only, not dim-and-skip.** Principle 6 added to generalize it. | The asymmetry needed a record: `nontext` is a fact about the model, `routable` a measurement of a configuration at a moment. Blocking on a perishable measurement turns snapshot staleness into an outage on up to 94% of rows. Severity supports it: `ModelRegistry.resolve()` returns `undefined` and the request fails loudly rather than misrouting. |
| **C18** | **`build()` stays synchronous; the fetch moves to `snapshot.mjs:main()`, which is already `async`.** | `test/uwpick.test.mjs:119` and `menu/catalog.mjs:112-127` establish that the picker's blocking `readSync` loop never drains the microtask queue, so a promise on that path is unreachable by construction. Keeping `build()` sync is what keeps the fetch in the refresher. |
| **C19** | **T4 raises `routableSet`'s timeout for the build path and makes `fresh: false` announce itself.** | 400 ms was sized for a path that does not exist. Once B1 is fixed, a silent timeout would reproduce today's artifact exactly — which is what §1.10 is made of. The announcement is the control; failing the build would be the overreaction (§5). |
| **C20** | **Mutation boundary 7 added, and it is the current state of the code.** | Dropping `routable` from `buildSnapshot` is not hypothetical: it is B2. It survived because a key-set assertion omitted the field. The replacement assertion must be positive — present on every model, values not uniform — because a key-set test alone passes a snapshot where every value is `undefined`. |
| **C21** | **T9 step 5 asserts both dim classes behave differently, live.** | The one check that catches someone quietly folding `routable` into `isSelectable` after D9. |
| **C22** | **§7 notes the two lanes meet at 91.** | After T4 the picker discloses which of its 1,588 rows are among the 91 CCR routes — the same set the declaration lane describes. The scope split becomes a relationship rather than two unrelated numbers. |

## 10. Revision 4 changelog (second Architect + Critic pass)

| # | change | why |
|---|---|---|
| **C23** | **`assertOptionsComplete`'s second argument is the post-strip `settings.modelPicker.options`, and the call moves after `:869`.** Corrected in D8-A, §3, §5's tier-2 header and T8. | `optionRows` at `:867` still carries `contextTokens` and, after T7, `kind`. V8 would have fired on every row of every clean build, thrown into the rollback at `:891`, and made T8's own acceptance criterion unsatisfiable. `model` survives the strip, so one array serves both rules. |
| **C24** | **"Mechanically enforces T1 ⇒ T7" withdrawn in all five places.** Replaced by two real measures in §1.9: T1 carries the V7 assertion in its own rewritten `:1011` test, and T7's end-to-end acceptance runs through `orderNativePickerOptions`. | `assertOptionsComplete` is introduced in T8, downstream of both — at the moment a T7-without-T1 commit could exist, the guard does not. What it genuinely buys is kept and restated: once T1 lands it can never be silently un-landed. |
| **C25** | **Principle 6 replaced with "block only when selection cannot possibly succeed; dim when it might."** | "Skip on facts, dim on measurements" is refuted by `run.mjs:363-365` in the same file — `--verified-only` drops rows on a perishable probe, justified by the exact downside D9-A accepts as a pro — and collided with Principle 5. D9-A's conclusion was never in doubt; only the generalization failed. Impossibility-vs-uncertainty resolves `nontext`, `routable`, `--verified-only` and `nvidia/bge-m3` alike. |
| **C26** | **B5 added to §1.10: `menu/catalog.mjs:107-110` names `refresh/cli.mjs` as the sole caller, and no `refresh/` directory exists.** T4 gains a step and an acceptance criterion. | This is B1's causal root. The wire was not forgotten — it was designed to originate in a module that was never built (`plans/phase6-menu-and-catalogue.md:289`), under a comment asserting the caller exists. A reader auditing `routableSet` met a confident sentence instead of an absence. By T1 step 6's own standard, that comment is the defect. |
| **C27** | **Boundary 7 and T4's central acceptance made gateway-free.** Live non-uniformity moved to T9 step 5. | R3 required a running CCR inside `node --test`, on the very path T4 step 6 exists to handle: with the gateway down the criterion fails indistinguishably from a broken build. `build({routableOf: () => true})` / `(() => false)` + `buildSnapshot` catches B2 and B3 exactly, offline. |
| **C28** | **T4's raised timeout pinned at `timeoutMs: 5000`, passed explicitly, with its reasoning.** | It was the one unpinned constant in a plan that pins every other one with evidence — in the step whose entire purpose is that a silent timeout reproduces the bug. |
| **C29** | **The `fresh: true` but empty-set case gets its own line and its own test.** | `makeRoutableOf(set, true)` over an empty set returns `false` for all 1,588 rows: every row dims while the stamp claims freshness. A different fact from "nobody answered", and §5 covered only the latter. |
| **C30** | **V6 widened from `capable !== weak` to the whole four-key table shape.** | It guarded one of three ways the table can break; setting `unknown` or `nonchat` to the capable target flips 38 or 4 rows with `capable !== weak` still true and every other rule green. |
| **C31** | **T4 states and accepts that ~94% of the picker renders dimmed**, with the inversion remedy named and deferred to T9 step 5. | The number was known but the rendering consequence was never drawn. At that ratio the dim stops signalling "exceptional". Not an argument against T4 — today's state is worse — but a judgement that needs the rendered screen, so it is scheduled rather than pre-decided. |
| **C32** | **T4's import constraint written down: extend the existing `await import("./catalog.mjs")`.** | A top-level `import { routableSet }` would compile, pass every test, and quietly pull `catalog.mjs` → `keysync.mjs` into uwpick's transitive graph, invalidating the line-budget test's definition of its own scope. |
| **C33** | **The per-model field renamed `kind` → `outputKind` in the menu pipeline** (keysync's row field stays `kind`). | `item.kind ∈ {model, provider, pinned}` versus `model.kind ∈ {text, nontext, null}` in one predicate, on an object T4 has just given a third status field. **(R4 placed the rename in T5, which C38 shows would have shipped a broken T5. The rename is correct; its placement was not — the field is now named `outputKind` at T3, from birth.)** |
| **C34** | **T5 gains `clamp`'s two ordering hazards** (viewport derived from the pre-correction index; double-correction on the arrow path) and an acceptance criterion for single-step movement. | Both were R1 findings that never landed. Each is invisible to a test that only checks the cursor ended somewhere selectable. |
| **C35** | **T5 step 2 reconciles pin-dropping with Principle 4.** | It is a hide sitting under a never-hide principle. The reconciliation is real — the row still renders in the tree, what is dropped is a duplicate shortcut whose only possible action is refusal, and `initState:15-16` already establishes the rule — but it needed saying rather than leaving for a reader to find. |
| **C36** | **§7 reframed: `MAX_MODELS_PER_PROVIDER` recorded as deprecated by user decision**, its original rationale kept for provenance only. Follow-up recorded in `plans/open-questions.md`. | The cap's two justifications are moot (uwpick is the real picker; attack surface deserves its own solution). §7's load-bearing claim — 83 is today's *complete* routable set — is unaffected and now stated as a current fact rather than an endorsement. |
| **C37** | **Smaller (R4):** `test/snapshot.test.mjs` dropped from T2's file list (nothing to do there once the bump moved to T4; its `BUILT` fixture never passes through `buildFrom`); lane diagram no longer implies T2 depends on T1; §3's `isSelectable` corrected to five call sites plus one upstream filter; `phase6-design-notes` citation made `:330-331`; the symmetric landing note added — a stall in T4 leaves T2 and T3 **inert**, not partially delivered. | Accuracy. *(Constraint 27 verified at `plans/phase6-menu-and-catalogue.md:46` — line 44 is constraint 25, 45 is 26, 46 is 27 — so R3's citation was already correct and is unchanged.)* |

## 11. Revision 5 changelog (final pass — three edits, no re-sequencing)

Both reviewers agreed the plan closes with these. Task list, lane structure and every decision record
are unchanged; C38 is the only one either reviewer rated blocking.

| # | change | why |
|---|---|---|
| **C38** | **The menu-pipeline field is named `outputKind` at T3 steps 2-3, from birth. T5 step 0 (the rename) is deleted.** | R4's ordering was a live defect, not a tidiness point. T4 serializes the field, bumps the schema and **rebuilds**; `menu/snapshot.mjs:53` validates only `schemaVersion` and `Array.isArray(rows)`, so the T4-built file loads cleanly carrying `kind`. T5's `isSelectable` would then read `undefined === "nontext"` — **every non-chat row stays selectable and the dim never fires** — while T5's fixture-driven acceptance stays green. A task shipping nothing while reporting success is driver 3's vacuity and the same silently-degraded-artifact mechanism §1.10 documents five times over. Deleting T5 step 0 also makes §4.3's "breaks at T3 and again at T4" true (it was three times) and repairs T5's file list, which omitted the two files step 0 named. keysync's row field stays `kind`. |
| **C39** | **The `run.mjs:869` strip extension moves from T8 step 2 into T7 step 5.** | The task that adds `kind` to the picker row is the task that strips it. §2 makes a post-T7 commit a legitimate stopping point, and between a T7 that adds the field and a T8 that removes it, a `--target live` run writes a fifth key into a file whose zod schema is exactly four — with V8 not yet existing to catch it. R1 carried a HAZARD box for the analogous pre-T1 window; this one had none. |
| **C40** | **`test/style.test.mjs` added to T2's and T5's file lists and documented in §4.3. The "no width assertions" generalization is withdrawn.** | R1's correction was narrow and right — `test/menu-layout.test.mjs` has none — but R2-R4 widened it into "no width assertions anywhere", which is false. `test/style.test.mjs` holds three: `:164` (every column begins where `W` says, naming the column on failure), `:238` (every frame line is exactly `FRAME_W`, across four view states and both capability sets — this is the assertion R4 offered to write), and `:409` (**the `ctx` cell never overflows**, written after `ctxS` clipped the `M` off `1.048576M` — the exact cell D2-A and T5 step 5 make polymorphic). T2's offer to add an assertion is withdrawn. D2-C's rejection is unaffected; it stands on its sufficient reason. |
| **C41** | **Principle 6 gains a security-control exception and drops `--verified-only` as precedent.** | `menu/denylist.mjs`'s `admitId`/`admitRemoteModels` block ids that would route perfectly well (`UW_ALIAS` squatting, over-length ids, `@cf/` scoping) — namespace ownership, not impossibility — so the principle as written forbade shipped, correct behaviour. And the new standing rule (C42) supersedes R4's `--verified-only` reconciliation: that pruning is non-compliant, so it cannot be cited as legitimate precedent. Principle 6 now rests on impossibility-versus-uncertainty plus the named exception. |
| **C42** | **New standing project rule recorded in Principle 6 and in `plans/open-questions.md`: a provider that is alive and responding is never classified dead or removed from routing.** | Measured 2026-09-06: 57 of 218 live probes (26%) failed on money, not absence. Alibaba had two rows verified on 2026-09-01 and 403 on everything five days later over an unpaid bill. `keysync/verify-cli.mjs:38-39` already records the sibling scar — pruning on a transient failure is "a one-way ratchet ... which is how mistral was lost to a single 503" — and a balance is worse than a 503, because a 503 clears itself. This is independent confirmation that D9-A is the only compliant choice for `routable`. `--verified-only` (`run.mjs:363-380`) is marked non-compliant today: it filters `built.providers` as well as `built.picker`, so running it while a provider is unfunded deletes that provider's entire catalogue from routing. Pre-existing, out of scope, flagged so it is not cited again. |
| **C43** | **D9-A gains the probe measurement.** | ~205 of 1,588 models are reachable at current balances, ~260 if the unfunded accounts were paid — so T4's dim covers roughly **114 models that are genuinely reachable** but absent from `Providers[].models`. Blocking on `routable` would block reachable models. Independent support for a decision that previously rested on staleness alone. |
| **C44** | **§1.9's three mechanisms are relabelled by role — exactly one orders.** | R4 called the `:1011` move and the T7 acceptance "two ordering measures". The `:1011` move is a *durability* property: if T7 landed without T1 the test would not exist either. Only T7's acceptance routed through `orderNativePickerOptions` orders anything; `assertOptionsComplete` extends durability to the write site. |
| **C45** | **§7's widening sentence corrected — it was backwards.** | R4 said widening the cap "would put hundreds of unverifiable rows in the picker". Widening `MAX_MODELS_PER_PROVIDER` widens `Providers[].models`, which `routableFromConfig` reads, so it moves rows from `routable: false` to `true` and **reduces** the dimmed count; it adds nothing to uwpick, which already shows all 1,588. Where it adds rows is the native `/model` menu, which has no dimming — which is the real prerequisite relationship. |
| **C46** | **T3 stops citing `inferTier` as its rule exemplar; `makeRoutableOf` replaces it. Recorded as OQ-5.** | Probe-confirmed: `inferTier` reads `pricing.inputPerMillion` while this schema stores `pricing.offers[].per1MTokens`, so it finds a usable number in **0 of 4,298** entries and the free-first sort at `keysync.mjs:365` is a no-op. `menu/catalog.mjs:29-31` already documents this verbatim. Citing a dead function as the model for honest-unknown labelling, in a plan whose Principle 1 is exactly that, would have been unfortunate. Placement beside `inferTier` is kept for locality. |

**Not changed, and deliberately.** The Architect read V6's canary sentence as removed by C30's widening.
It is intact, immediately below the V6 row: *"V6 is the canary for the failure that looks like
success."* C30 added three sentences without removing it and the rule got strictly stronger. The
Critic verified this independently. No edit.

# Model resolver — locked design decisions

Branch `fix/model-resolver`, off `fix/model-capability-buckets`. Goal, set by the user:
**fix model discovery and resolution for every model our provider keys offer.**

Decisions D1–D5 are LOCKED by the user 2026-09-06. They are inputs to planning, not open
questions. Everything under "Still open" is not.

**Measurement convention.** *(measured)* = executed this session against real files.
*(read)* = static source reading. Figures without a marker are inherited from a cited report
and were not re-run.

---

## 0. Superseded figures — do not cite these

An earlier revision of this discussion, and the message that locked these decisions, carried
numbers since re-measured. They are recorded here only so a planner recognises and discards them.

| superseded | actual *(measured)* | why it moved |
|---|---|---|
| "641 of 3,752 live rows join (17%)" | **3,046 of 3,784 (80%)** — **unguarded; the guarded rate is 65.0%** *(revision 10, §1 amendment 1)* | the 17% used bare-tail matching only, and ignored the bundle's own `aliases[]` field (10,184 entries) and vendor-qualified tails. The 80% remains the honest correction of the 17%, but it is a **provider-free** figure and must never be cited as an acceptance threshold for a §4.3-compliant join |
| "~0 capable / 3,720 weak" | ~80% classified, ~20% weak | that was the live-only scenario, which D3 rejects |
| "the other 23 providers hold one model each" | **22 providers, 1,374 live models, 77% join** | the "one row" described UW's current *output* under bundle-only discovery, not those providers' inventory. `nousresearch` alone lists 390 |
| "1,281 phantoms" | ~738 unjoined of 3,784; phantom count is a separate quantity not re-measured | different denominators; the phantom set is bundle-rows-absent-from-live, measured per provider in the discovery pass |
| "`MAX_MODELS_PER_PROVIDER` bounds reach" | contributes **0 to uwpick**, but is the **sole size control on `built.picker`** *(measured; row corrected 2026-09-06)* | `menu/catalog.mjs:buildFrom` emits every catalogue entry uncapped, so uwpick's 1,588 rows are unaffected. But the same constant — `keysync.mjs`'s `MAX_MODELS_PER_PROVIDER` — caps `built.picker` at 3/provider — 83 rows, 44 providers, **18 of them exactly at the cap**. See §6 |

---

## 1. The measured baseline

Sources: CCR bundled `dist/models.json` (`schemaVersion: 2`, `generatedAt: 2026-08-24T12:22:28.162Z`,
4,298 models / 217 providers, merged models.dev 2,796 + litellm 2,034 + openrouter 419, **10,184
aliases**) and `~/.maestro/model_cache.json` (live authenticated listings on the same 44 vault keys).
No network call, no key read, in-process only.

**Join ladder, over 2,136 distinct live id strings** *(measured)*. **The ladder below was measured by
a provider-free matcher and does not describe a §4.3-compliant join** — amendment 1 below, revision
10. The figures are kept as history and are labelled rather than deleted:

| strategy | +hits | cumulative |
|---|--:|--:|
| exact — bare ∪ full `provider/model` ∪ **`aliases[]`** | 914 | 43% |
| normalisation (`models/`, `:free`/`:batch`, `.`→`-`) | 51 | 45% |
| case-insensitive | 38 | 47% |
| **vendor-qualified tail match** | 376 | 65% |
| + `accounts/…/models/`, leading `~`, `[…]` suffix | **≤14** | **≤65.3%** *(corrected — amendment 2)* |
| residual | **~742** | **~34.7%** *(corrected — amendment 2)* |

**Per (provider, model) pair, 42 provider roots** *(measured)*: **3,784 live pairs, 3,046 join (80%)
— unguarded.** Re-measured to the row 2026-09-06 on the same denominator *(revision 10)*: **3,037 /
3,784 = 80.3% loose, with no guard**, which reproduces the locked 3,046 (80%); and **2,460 / 3,784 =
65.0% guarded, per §4.3**. The 80% figure is the ceiling of a matcher this design does not ship.
**65.0% is the rate a §4.3-compliant join achieves**, and it is the figure R5's observable now states.
Bundle-covered providers 82%; providers with zero bundle coverage 77%. Coverage is near-uniform
once the join uses `aliases[]` and vendor-qualified tails — the bundle's *provider* coverage
barely matters.

**Amendment 1, 2026-09-07 — this section's ladder and R5's observable were not simultaneously
satisfiable, and the cause is here, not in the implementation** *(revision 10)*.

R5 shipped (`77c9cc6`) and its primary observable — *"≥75% of the 3,784 live (provider, model) pairs
join"* — **failed**. Re-measurement found no defect in the join. It found a contradiction between two
locked statements:

- the rung table above **reproduces exactly** — 42.8 / 45.2 / 47.0 / 64.6 against its own 43 / 45 /
  47 / 65 — **only** with a **provider-free matcher**: one with no provider in hand, which therefore
  **cannot obey §4.3's same-provider guard**;
- §4.3 is a **decision** and requires that guard.

§1 is an observation of a prototype; §4.3 is a decision. They describe incompatible things, and no
implementation can satisfy both. The rung table is therefore labelled, not repaired: it records what a
provider-free matcher reaches, and **that is not this design's matcher**.

**The guard stays. This is the user's decision, recorded as such** *(2026-09-07)*. The 577-pair gap
between 3,037 and 2,460 closes at **Ship C, with first-party listing data** — R8 already keeps
`contextLength` and `capabilityRaw` per model from each provider's own authenticated listing — **not
with a cross-provider guess**.

A uniqueness-gated rung was measured and **rejected**: **76.8%** of the refused pairs (447 of 577)
have a bare id that is unique catalogue-wide, so a uniqueness gate would recover them — but **168 of
458 multi-provider ids (37%) disagree on `ctx`**, so a row recovered that way inherits one arbitrary
vendor's number. `inkling` carries six values from **65,536 to 1,048,576**; `mimo-v2.5-pro` four
across **24 providers**. Recovering a row by attaching a wrong context window is a confident-wrong
under [[models-used-as-designed]], and the honest miss is preferred. **Do not re-litigate the guard on
reach grounds** — the reach is recovered at Ship C from the provider's own data.

**Amendment 2, 2026-09-07 — the ladder's last rung is arithmetically impossible** *(revision 10)*.

**What the table used to say:** the `accounts/…/models/` + leading `~` + `[…]` rung carried the
cumulative from **65% to 70.9%**, i.e. **+5.9pp ≈ 126 ids**, with a **residual of 622 (29.1%)**.

The live corpus cannot supply 126 ids for that rung. It holds **13** leading-`~` ids, **1** bracketed
id (`kimi-k3[1M]`), and **0** `accounts/…/models/` ids — **14 total, a ceiling of 0.66pp** *(measured)*.
The 13 is the same count §2.5 of the plan and D2's table below already carry, so this is the same
corpus, not a different one. The corrected rung is therefore **≤14 hits, cumulative ≤65.3%**, and the
residual moves with it to **~742 (~34.7%)** — arithmetic from the corrected ceiling, not an
independent re-measurement. The prose below reading *"~622 unclassifiable ids"* inherits the same
error and should be read as **~742**.

**The residual is not a normalisation defect.** All string rules combined contribute ~89 hits (4%).
What remains is two populations no rule can reach:

- **staleness** — `gpt-6-astra`, `gemini-3.8-flash`, `claude-fable-5-1`, `glm-5.3-flash`,
  `qwen3.8-max-2026-09-02` postdate the 2026-08-24 bundle. It has never heard of them.
  13 days of drift produced ~622 unclassifiable ids.
- **coverage** — ~93 HuggingFace-style open-weight ids (`Qwen/Qwen2.5-VL-72B-Instruct`,
  `inclusionAI/Ling-1T`, `ByteDance-Seed/Seed-OSS-36B-Instruct`) that no upstream indexes, plus
  two house-branded providers with genuine 0% joins: **agnes** (11) and **fanar** (11).

Greedier normalisation costs accuracy and is rejected: stripping date suffixes merges
`claude-3-haiku-20240307` with `-20241022`; stripping `-instruct` merges base with instruct
variants. Different weights, different capabilities.

**Entitlement is not reachability.** 3,784 is what the keys are entitled to list. Listings
over-report ~2.4× (report 20 §3); ~205–260 complete today, money-blocked accounts being most of
the gap. Under [[responding-provider-never-pruned]] that is state to surface, never a reason to
withhold routing — but no artifact may claim "3,784 working models".

---

## 2. D1 — `checkBareCollisions` classification set

**Locked.** The null-fallback becomes the static curated set, not broad `RESERVED`:

```
classify id  ⟺  ANTHROPIC_ALIASES.includes(id) || (realIds ?? ANTHROPIC_FULL).has(id)
```

**What the guard defends, unchanged.** CCR `resolve()` stage B4 matches *bare* names across all
providers and binds when exactly one owns it. Claude Code emits bare `opus`, `sonnet`, `haiku`,
`fable` for its built-in rows. A third party sole-owning one of those receives the full system
prompt, tool definitions and file contents. Two owners fails closed to `undefined`, which is safe.
This exact hole was live in `eeea057` until `3fa8025`.

**What it does not do.** It never prunes a model. `keysync/run.mjs` already skips any id containing
`/`, so `tabiai/claude-opus-5` routes normally via B2. The guard's only action is `process.exit` —
an availability failure, not a reach failure.

**Why the change.** At width with `realIds === null`, 23 ids classify as hijackable and keysync
exits: `claude-opus-4-8-think`, `claude-opus-4.6`, `claude-opus-5-fast` and similar reseller
inventions across aihubmix, bai, veniceai, tabiai, tokenrouter, opencode. Nothing ever sends those
bare. All 23 are false positives, and the trigger is a *network failure* reaching Anthropic's
catalogue — not a change in the config's actual risk.

`ANTHROPIC_FULL` is a static constant already in source, so `realIds` effectively never goes null.
Every real protection is retained: a reseller sole-owning bare `opus` still exits non-zero.

**Out of scope here**, deliberately: the per-id vouch for legitimate Anthropic resellers (#9,
BACKLOG item 2). D1 removes the false-positive class; it does not give a resller sole-owning a
*real* published Anthropic id a path past the guard. That remains open and is listed below.

## 3. D2 — `MODEL_ID_OK` inverts from allowlist to denylist

**Locked.** Current shape, `menu/sanitize.mjs`:

```js
export const MODEL_ID_OK = /^(?:@[A-Za-z0-9]|[A-Za-z0-9])[A-Za-z0-9._:@\/-]{0,127}$/;
```

An allowlist refuses anything unenumerated. `~` and `[` are not dangerous — nobody decided against
them.

**Cost, stated in both units because the plan uses this as an acceptance figure**
*(measured on live data 2026-09-06, re-verified)*:

| unit | count | what it means |
|---|--:|---|
| distinct refused **id strings** | **14** | how many distinct models become reachable |
| distinct refused **(provider, id) pairs** | **40** | how many routing rows are recovered |

Both are correct and they differ because a floating alias is served by several providers —
`~z-ai/glm-latest` appears under kilo, openrouter and nousresearch. **An acceptance criterion must
say which unit it counts**: "40" is the routing-row figure, and a check written against distinct
ids would fail it while the fix is working correctly.

The 14 ids are 13 leading-`~` floating aliases (`~z-ai/glm-latest`,
`~deepseek/deepseek-v4-flash-latest`, `~anthropic/claude-opus-latest`) plus one bracketed id,
`kimi-k3[1M]`. Spread across providers those become 39 alias pairs at OpenRouter, Kilo and
NousResearch plus `teamorouter/kimi-k3[1M]` — the 40.

**Zero dangerous ids are refused**, measured across 7,730 bundle ids and 2,136 live ids: leading
`-` **0**, leading `/` **0**, malformed `@` **0**. That is what makes the leading-separator
denials free to keep when the allowlist inverts.

The same shape already failed once for Cloudflare, and that file's own comment records it:

> the original anchor demanded an alphanumeric first character while allowing `@` in every later
> position, so it **refused a working provider on punctuation rather than on any property worth
> defending**

**New rule: deny the genuinely dangerous, accept everything else.** The threats are already
expressed as separate regexes in the same file and are reused, not re-typed:

| denied | reason |
|---|---|
| `ESC_SEQ` | CSI/OSC/Fe terminal escapes — screen clear, cursor move, OSC-52 clipboard write |
| `CTRL` | C0 incl. CR/LF/NUL, DEL, C1 range |
| `INVISIBLE` | zero-width, bidi marks, **U+202E RLO** — renders an arbitrary id as an Anthropic lookalike |
| `\` | must never reach a filesystem path |
| `..` | traversal |
| length > 128 code points | `settings.json` is parsed at every CC launch |

Everything else is admitted, including `~`, `[`, `]`, and any future naming convention — no source
edit. That is [[key-lifecycle-must-scale]] directly.

`/` stays legal: `groq/openai/gpt-oss-20b` is a real two-slash id.

## 4. D3 — capability source: union with a provenance ladder

**Locked.** The question splits in two, and the pillars answer them differently.

### 4.1 Candidate source = `union(discovery ids, catalogue ids, testModel)`, led by the live listing

The live listing **leads** that union. Demoting the bundle from sole source to one contributor is
what [[key-lifecycle-must-scale]] and [[route-max-working-models]] both point at, each citing report
20's recommendation:

> replacing the bundled catalogue with each provider's own authenticated listing as the candidate
> source

The bundle *is* the "hand-maintained snapshot that silently goes stale" the pillar was written
against — third-party npm artifact, frozen until `npm i -g`, and a global reinstall already wiped a
local patch once (report 08 F9).

Rows are unioned and ranked by provenance (discovery-design §2):

```
call-verified  >  config-asserted  >  listing-verified  >  catalogue-only
```

- **`testModel` always survives** regardless of the listing. Listings under-report —
  catalogue-first dropped the live pass rate to 4/44.
- **catalogue-only rows are kept, dimmed, and ranked last.** Report 20 §4 class 1: model absent →
  dim, never prune. [[responding-provider-never-pruned]].

**Correction, 2026-09-06 — the heading and epigraph asserted listing-as-*the*-candidate-source, which
the two bullets above have never said. Both are rewritten; the bullets are untouched.** *(#58)*

**What the heading and epigraph used to say, and why they were wrong.** The heading read *"Candidate
source = live listings"*, and the epigraph introduced the report-20 quote as *"Named explicitly by
[[key-lifecycle-must-scale]] and [[route-max-working-models]]"* — presenting the fragment as a pillar
demand for an **exclusive** source. Two things are wrong with that. The narrower one: neither pillar
demands it in its own voice. Both attribute it — [[route-max-working-models]] says *"report 20
**recommends** replacing the bundled catalogue …"* — and that same pillar bounds it in the next
breath: *"Blocking, capping, hiding and pruning all need affirmative justification and irrefutable
evidence."* The load-bearing one: read as a candidate **rule**, "the candidate source is the live
listing" **prunes** a provider whose listing returns empty — the `!models.length` skip in
`keysync/keysync.mjs`'s `buildProviders` `continue`s before that function's `out.push` — which is
precisely what the two bullets above forbid.

*(Citation form, revision 11. Every reference to this skip below names the **symbol**, not a line
range. The three sites that carried `keysync.mjs:558-564` were correct when written at `78c0990` and
were broken by R3 and R4 in this same branch, which added ~110 lines above them and moved the skip to
`:709`; a reader following the old number landed in `normalizeModel`'s JSDoc and found no `continue`
at all. Four more tasks write this file before the branch ends, so re-numbering buys one ship's
accuracy and re-breaks immediately. This follows the precedent commit `5f7c851` already set for this
repo — "cite symbols, because these line numbers were stale on arrival".)*

**The heading asserted one rule while the body specified another, and D5's routing clause inherited
the heading's framing** rather than the body's. That is the path by which #58's pruning defect
survived inside a locked decision; see D5's amendment below, which is the seventh and last site.
Row survival is unchanged here: `testModel` always survives, catalogue-only rows are kept, dimmed and
ranked last.

**Amendment, 2026-09-06 — the ladder gains a fourth rung. Row survival is unchanged; only the
confidence label moves.** *(#59)*

This amends a locked decision, so it is recorded rather than edited silently.

**What this section used to say, and why it was wrong.** The ladder had three rungs, and the
`testModel` bullet read *"It is probe-verified, and listings under-report."* The second clause is
still true. The first was a **confident-wrong**: nothing re-probes `testModel`. It is a field read
out of `providers.json`, and the ladder's own definition of its top rung is *"a real completion
returned 200."* A lapsed subscription, a revoked key, or a decommissioned `testModel` would keep
rendering `call-verified` — the top of the ladder — for as long as the string sits in the vault. The
picker then ranks a dead row **above** a live `listing-verified` one, which is the inversion the
ladder exists to prevent. The same defect appears in the plan at §2.3 and R14, where the relay's
four models are also assigned `call-verified` as a literal.

**The fix.** `call-verified` is now reserved for an **actual dated probe result** — a completion
this system ran and recorded. Nothing may assign it as a config literal. Two populations move down
one rung to `config-asserted`:

- the vault `testModel` for every provider;
- the relay's four Anthropic models (hardcoded in `menu/catalog.mjs`'s relay branch; `anthropic` is
  `listing: null` and is never discovered).

`config-asserted` means *asserted by local configuration, never probed*. The `-asserted` suffix
against `-verified` is the whole point: a `verified` rung was established by something this system
**observed** (a completion, a keyed listing); an `asserted` rung by something a human **wrote
down**. Naming it `vault-asserted` was considered and rejected — the relay's four models do not come
from the vault at all, so that name would be a confident-wrong on half the population it labels.
`config-asserted` names the *evidence class*, which is the same discipline `listing-verified` and
`catalogue-only` already follow.

**It sits above `listing-verified`, deliberately.** These are the subscription models and the
provider's own nominated model; a third-party listing row must never read as *more* confident than
the four Claude models the user certainly has. That inversion is #45, and demoting straight past
`listing-verified` would have reintroduced it while fixing #59.

**Row survival is untouched.** Everything above still holds exactly as written: `testModel` always
survives regardless of the listing, and catalogue-only rows are kept, dimmed and ranked last. This
amendment changes **what a row is labelled**, never **whether a row exists**. A careless reading
could take a demotion for a prune; a prune here would be a direct [[responding-provider-never-pruned]]
violation (#58), and none is intended or authorized by this amendment.

**Why this ships now rather than deferring with the rest of the freshness work.** The rung
vocabulary is persisted in snapshot schema 3. Shipping `call-verified` on unprobed rows would force
phase B to either migrate 3 → 4 or carry two incompatible meanings of one string in one schema. The
fix itself needs no probe, no clock and no cadence — it is honest today, at zero phase-B dependency.
Actually *promoting* a row back to `call-verified` does need a probe, and that stays deferred; the
ladder simply has an honest place to hold the row until then.

### 4.2 Capability = join to the bundle, `null` on miss

`reasoning` exists **only** in the bundle. No provider's `/v1/models` carries it — verified across
deepseek, google and openrouter, whose live rows are `{capability, display_name, id, tier}`.
So `bucketFor()` can only be fed by a join.

| condition | `bucketFor` | `behavesAs` | live rows of 83 |
|---|---|---|--:|
| `kind === "nontext"` | `nonchat` | weak target | 4 |
| joins, `capabilities.reasoning === true` | `capable` | capable target | 24 |
| joins, `=== false` | `weak` | weak target | 10 |
| joins, no `reasoning`, `limits.contextTokens >= CTX_CAPABLE_MIN` | `capable` | **capable target** | 3 |
| joins, no `reasoning`, `contextTokens > 0` and below it | `weak` | weak target | 4 |
| no join → `null`, or joined with neither field usable | `unknown` | weak target | 38 |

**Amendment, 2026-09-06 — the table had three rows where `bucketFor` has six branches. No target
moves; the two missing rows are written down.** *(#66)*

This amends a locked decision, so it is recorded rather than edited silently.

**What this section used to say, and why it was wrong.** The table was:

> | joins, `capabilities.reasoning === true` | capable target |
> | joins, `=== false` | weak target |
> | no join → `null` | weak target |

The third row is right in **outcome** and is kept: a genuine miss yields `reason: null` *and*
`contextTokens: undefined`, so `bucketFor` returns `"unknown"`, and
`BUCKET_TARGETS.unknown === BUCKET_TARGETS.weak`. What the three rows omit is the case where a row
**joins**, carries `limits.contextTokens`, and has **no** `capabilities.reasoning`. There reasoning is
genuinely unknown and **context size is used as a proxy** — and unlike every other unknown path, that
proxy can **promote a row to the capable target**. A reader taking the three rows as complete would
believe an absent `reasoning` can only ever yield the weak target. It cannot only ever.

**Footprint today: 3 of 83 rows**, and they are the same three the source comment at
`keysync/keysync.mjs`'s `CTX_CAPABLE_MIN` already enumerates when it justifies `>=` over `>` at the
boundary — `cerebras/llama3.1-8b` (exactly 128000), `cloudflare/granite-4.0-h-micro` (131000),
`sambanova/gemma-4-31b-it` (131072). The classifier itself is that file's `bucketFor`.

**This is not the id-string inference this section forbids.** `contextTokens` is a *measured field* on a
joined row, and it is used only where `reasoning` is absent. The prohibition below is on reading
capability out of a **name** (`-thinking`, `-r1`, `o1`); a declared window is evidence, a substring is
not.

**Why this is not merely documentation.** D4 step 1 widens routing by ~43×, and R11 spends the live
`capability` field from discovery. **A listing that reports a context window but no reasoning flag is
a common shape**, so this branch governs a population far larger than 83 the moment discovery lands.
The row has to be in the table *before* R11 is written against it.

**No target changes.** `BUCKET_TARGETS`, `ALLOWED_BEHAVES_AS` and `CTX_CAPABLE_MIN` are untouched by
this amendment and stay untouched by this branch (§9.1). It records what the code already does.

Weak-on-unknown is not degradation, it is what [[models-used-as-designed]] prescribes:

> When a model's real capability is knowable, use it rather than a borrowed default. When it is
> **not** knowable, prefer the **honest minimal assumption over a confident wrong one**.

**Never infer capability from the id string.** `-thinking`, `-r1`, `o1` in a name is a
confident-wrong. Tri-state honesty holds: `true` / `false` / `null`, never `!!` coercion.

### 4.3 Join guard

Bare names never join cross-provider. `auto`, `hy3`, `inkling`, `mistral` carry no vendor prefix
and stay `null`. This is the measured false positive that loose matching produced in the bucketing
work — `orcarouter/auto` matched `morph/auto`. Prefix present → join; absent → unknown.

**Confirmed by the user 2026-09-07, after the guard's cost was measured** *(revision 10)*. The guard
costs **577 (provider, model) pairs**: a §4.3-compliant join reaches **2,460 / 3,784 = 65.0%** where a
provider-free matcher reaches **3,037 / 3,784 = 80.3%**. The user's decision is that **the guard
stays**, and the reasoning is recorded in full at §1 amendment 1: the gap closes at **Ship C with
first-party listing data**, and the uniqueness-gated rung that would have recovered 76.8% of the
refused pairs was rejected because **37% of multi-provider ids disagree on `ctx`** — `inkling` carries
six values from 65,536 to 1,048,576 — so a recovered row inherits one arbitrary vendor's window.

**This section is the decision; §1's ladder is not.** §1's rung table was measured by a provider-free
matcher and cannot obey this guard; where the two conflict, this section governs. That is the
contradiction §1 amendment 1 resolves, and it is why R5's shipped observable failed on a correct
implementation.

### 4.4 The bundle is enrichment, never a dependency

Provenance makes the dependency explicit so a later swap — models.dev direct, or authenticated
capability listings (report 18 §9.6, *"the highest-leverage available upgrade"*, never probed) — is
a source change rather than a rewrite. A third source is **deferred**: report 18 §9.3 measured
models.dev alone as worse (25.3% of UW rows absent from it), and adding it now buys a new failure
mode before the join's ceiling is known.

## 5. D4 — widen routing first, curate the native picker second

**Locked as two steps, in this order.**

**Step 1 — widen `Providers[].models` to `union(discovery ids, catalogue ids, testModel)`.**
*(measured)* 3,720 models across
45 providers is 100 KB minified; CCR builds no index over `Providers[].models` at startup
(`gatewayModels` comes from `Sd()`, virtual profiles only), so startup cost is zero. It breaks
nothing on the 15-site consumer list — `keysync.mjs`'s `validate` ties them with a **subset**
assertion (`picker ⊆ models`), which widening *relaxes*. Independently shippable.

This is the B2 fix: ~1,501 rows currently resolve to `undefined` and fall through CCR policy 7 to
`anthropic/claude-opus-5`, which is the silent substitution in #47/#48.

***Correction, 2026-09-07 — the second clause is falsified and is withdrawn; step 1 itself is
untouched*** *(revision 10, #74, OQ-6)*. R1 ran. The layer that substitutes in #47 is **Claude Code's
`env.ANTHROPIC_MODEL` taking precedence over `settings.model`**, resolved client-side before the
request is sent; CCR rewrote nothing on any of the 25 measured rows. **Step 1's widening is unchanged
and still right** — it is justified on reach ([[route-max-working-models]]): ~1,501 rows do not route
today and will. What is withdrawn is the claim that step 1 *fixes #47/#48*. It cannot: the override
fires regardless of whether the selected model is recognized. See `plans/open-questions.md` OQ-6 and
the plan's §1.2 / §1.6 corrections.

**Amendment, 2026-09-06 — the candidate set is a union, not the discovered set. The widening is
unchanged; only its floor is.** *(#58)*

This amends a locked decision, so it is recorded rather than edited silently.

**What step 1 used to say, and why it was wrong.** It read *"widen `Providers[].models` to **every
discovered model**."* The intent — stop sizing routing from a cap of 3 — was right and is untouched.
But taken as the candidate **rule**, it removes a provider whose listing returns empty: in
`keysync/keysync.mjs`'s `buildProviders` the `!models.length` skip does a `continue` **before** that
function's `out.push`, so an empty candidate list drops the provider from `Providers[]` **entirely**
rather than dimming it.
Four providers fall in on this branch's own data — `tabiai` and `gorouter` (HTTP **200** with
`data: []`), `youcom` and `githubcopilot` (`listing: null`). Two of them answer.

*(Consistency note, 2026-09-06. Those four are the four **discovery** outcomes. Only `tabiai` and
`gorouter` can reach `buildProviders` at all: `keysync/keysync.mjs`'s `filterRegistry`, on its
`protocol: "generic"` exclusion, drops `youcom` and `githubcopilot` first, as D6
already records. **The amendment above is unaffected**; the candidate rule is still the union, and it
would still prune two live, responding providers. This note exists so a test written from this
paragraph asserts the two providers that can actually be lost rather than four.)*

**It also contradicted D3 §4.1**, which is locked and explicit: *"`testModel` always survives
regardless of the listing"* and *"model absent → dim, never prune."* A prune here is a direct
[[responding-provider-never-pruned]] violation — a listing, auth or billing failure is state to
surface, never a reason to stop routing. The union is the same candidate rule D3's ladder already
implies and the same one the display path builds, so routing and display now agree by construction.

**Nothing else about step 1 moves.** The measured figures, the zero startup cost, the `subset`
argument in `keysync.mjs`'s `validate`, the B2 fix above, and step 1's independent shippability are all
unchanged: a union is a superset of the discovered set, so every consequence measured for the wider
set still holds.

**Step 2 — the native `/model` menu stays curated.** It renders 10 rows at a time with 1-row
scrolling and no filter (report 04), so it cannot hold 3,784. uwpick already renders 1,588 with
filtering and is the surface that goes wide. Narrowing the native picker touches five sites and is
a separate risk profile:

| site | why it breaks on a narrower picker |
|---|---|
| `keysync.mjs` `reconcileUserModelPin` | deletes the user's saved pin if absent — must be fed the **routable** set |
| `run.mjs` `--verified-only` | filters `providers[].models` *by* surviving picker rows — backwards coupling, must be inverted |
| `run.mjs` `anchorModel` | falls back to `built.picker[0]`, silently repointing all six CCR profile tiers |
| `run.mjs` `assertOptionsComplete` | V7 forbids dropping a row at the write site — `options[]` is the only `behavesAs` channel, so curation must happen upstream of `built.picker` |
| `keysync.mjs` `validate` / `phase5-statics.mjs` T1.3 | subset assertions; safe in this direction but must be re-read |

**B4/B5 ambiguity blocks nothing** *(measured)*. Every UW-written selector is `provider/model` and
resolves at B2. At width, 667 bare ids are ambiguous and **all fail closed**; Claude-shaped
`hijackable` stays **0**. All four aliases CC emits are sole-owned by the relay.

## 6. D5 — `MAX_MODELS_PER_PROVIDER` retired

**Locked, and AMENDED 2026-09-06 after architectural review found a terminology error in the
original wording.** Already deprecated as a design by the user 2026-09-06; D5 removes it from
**routing**.

*(measured)* the cap contributes **0 to the discovery gap** — per-provider snapshot counts equal
bundled-catalogue counts exactly (alibaba 343=343, openai 337=337, google 185=185), because
`menu/catalog.mjs:buildFrom` emits every catalogue entry uncapped.

**The original wording then said "never touches the picker path." That is false, and it is the one
error in this document that a task inherited.** The word "picker" names two different surfaces:

| surface | built by | rows | capped? |
|---|---|--:|---|
| **uwpick** | `menu/catalog.mjs:buildFrom` → `menu/snapshot.mjs` | 1,588 | **no** |
| **native `/model`** — `built.picker` → `modelPicker.options[]` | `keysync.mjs:buildProviders` | 83 | **yes, by this constant** |

`keysync.mjs`'s `buildProviders` builds **one** array: `models` is capped by
`MAX_MODELS_PER_PROVIDER`, then feeds **both** the routing entry *and* one picker row each, in the
same pass. Measured against `keysync/built-rows.json`: **83
rows, 44 providers, max 3 per provider, 18 of the 44 sitting exactly at the cap**, and those 18
hold 1,555 catalogue entries between them. The cap site's own comment states the purpose the
original wording denied: *"Curate rather than dump: the picker is a flat list and 44 providers x
full catalogs is unusable."*

**So removing the constant outright takes `built.picker` from 83 to ~1,584 rows**, breaking D4
step 2 ("the native `/model` menu stays curated"), the 10-row/1-row-scroll/no-filter render
constraint, and the `settings.json` parse budget. That budget is tighter than assumed: the live
file is **23,242 bytes**, with `modelPicker.options` alone at **12,735 bytes over 94 rows — ~135
bytes per row** *(measured 2026-09-06)*. At 1,584 rows the options array alone would exceed 200 KB,
and Claude Code parses this file at every launch.

**Amended decision.** Retire the constant **from routing** — routing takes the uncapped
`union(discovery ids, catalogue ids, testModel)` — and keep a **distinct, renamed** constant
governing only the picker branch after the split. `UW_MAX_MODELS` and its `NaN` defect (#5:
`Number("x")` is `NaN`, and `n >= NaN` is always false, so a non-numeric value silently removes the
cap) die either way, as originally intended.

**Preferred form, if the measurement supports it:** size the picker branch by the *measured*
serialized budget rather than by an inherited magic 3. Every row moved into the picker is a row
that stops resolving through `lH()` to the maximal assumption set, so this directly shrinks D4
step 2's deferred bill instead of merely capping. `behavesAsFor` is
`BUCKET_TARGETS[bucketFor(model)]` — total by construction *(verified)* — so **every picker row is
declared**, and the undeclared population is exactly `routing \ picker`. Picker size is therefore
the dial that controls that population, not a cosmetic choice.

**Amendment, 2026-09-06 — the routing clause said "discovered set" and had to say "union". The
retirement is unchanged; only the set routing falls back to is.** *(#58)*

This amends a locked decision, so it is recorded rather than edited silently.

**What the amended decision used to say, and why it was wrong.** The routing clause read *"routing
takes the uncapped **discovered set**."* Retiring the cap is right and is untouched. But "the
discovered set" is a candidate **rule**, and as a rule it prunes: in `keysync/keysync.mjs`'s
`buildProviders` the `!models.length` skip does a `continue` **before** that function's `out.push`,
so a provider whose listing returns empty leaves `Providers[]` **entirely** instead of being dimmed. That is the identical defect
corrected in D4 step 1 above, and a direct [[responding-provider-never-pruned]] violation — a
listing, auth or billing failure is state to surface, never a reason to stop routing. The two
providers it reaches are `tabiai` and `gorouter`, both of which answer with HTTP **200**.

**Why this site survived a correction that reached six others.** D5 was amended earlier the same day
for a **different** reason — the original wording's *"never touches the picker path"* terminology
error, which the two-surface table above corrects. That amendment rewrote the decision's **picker**
clause and left its **routing** clause untouched, so when #58 corrected the "discovered set" phrasing
in six places, this one was never revisited. It is the site that matters most: the plan cites amended
D5 **by name** as the authority for R11's routing change, so an executor who checked the authority
landed on the one instruction that reintroduces the defect. The framing itself was inherited from
§4.1's heading and epigraph, corrected above.

**Nothing else about D5 moves.** The renamed picker-side constant, the two-surface table, the
measured ~135-bytes-per-row budget, the preferred sizing-by-measurement form above, and
`UW_MAX_MODELS` dying with its `NaN` defect are all unchanged: a union is a superset of the
discovered set, so every consequence measured for routing at width still holds.

**This also settles part of §8 item 2.** That item asks "what curates the native 87." The answer
today is this constant; the amended decision is that a renamed successor keeps curating it, sized
by measurement. What remains open is the *ranking* rule inside that budget.

Two consequences to carry:

- **The attack surface it was cited as bounding is not deprecated** (report 08 F3(b)/F11,
  design-notes control 3). It must be re-solved on its own terms — D1 and D2 are part of that, and
  the `settings.json` size bound moves to D2's length cap plus the native picker staying curated.
- **`UW_MAX_MODELS` parsing is defective and dies with it** (#5): `Number("x") = NaN`, and
  `n >= NaN` is always false, so a non-numeric value silently removes the cap entirely.

**`inferTier` (#10) is no longer a blocker for routing.** Ranking only matters when candidates are
cut to fit a cap. Going wide ranks nothing out. It still matters for badges and for whatever rule
curates the native picker, and the rescued `prior-art/uw-rust-tui/src/model_tier.rs` (448 lines,
11 tests) already works on today's schema, yielding `{paid: 3619, free: 405, unknown: 274}`.

## 6. D6 — model discovery, fetch-and-cache only

**Locked, with a hard scope line.** D3 and D4 have no data source without it: widening from the
bundle would declare deepseek's 102 fictional rows and google's 185 zero-overlap rows, and reading
`~/.maestro/model_cache.json` at runtime makes another tool's partly-stale artifact a dependency.
Every measurement in §1 is borrowed from Maestro; that is acceptable as evidence and unacceptable
as a runtime source.

**In scope:** authenticated listing fetch → parse → classify outcome → write a local cache with
provenance and timestamps. **Manual invocation only.**

**Out of scope, stays phase B:** any cadence or scheduling, provider health labels (#14),
consolidating `key-health.mjs` / `-reprobe` / `-live3`, the three-tier refresh architecture, and
per-model completion probing. This preserves report 08 F8's split — `refresh` is cache-only and
never touches `settings.json`, `config.sqlite` or the gateway; `apply` stays manual and
diff-then-confirm. Nothing new runs on a timer.

**Already specified, build rather than design:**

- `plans/phase6-discovery-design.md` §1 — profile-driven `listing.{url, envelope, idField, method}`
  with cluster-A defaults so 41 of 47 need no edit; `listing: null` as a positive assertion that no
  endpoint exists; six outcomes, with `empty` and `unsupported-shape` never collapsing into one
  bucket. **`unsupported-shape` is a non-waivable gate for the provider that produced it** — a
  provider being down is a fact about the world, an unparseable shape is our own defect. Coverage
  ratio is waivable with `--accept-coverage-delta`; a shape failure is not waivable for its own
  provider. *(**Amended 2026-09-06, #61.** This read **"Zero `unsupported-shape` is a non-waivable
  gate"** — i.e. run-wide, so one provider's novel envelope discarded 43 successful listings and
  forced a re-authorized re-run of all 44 authenticated calls, on the most expensive operation in the
  branch. The defect-detection intent is unchanged and fully preserved per-provider; only the blast
  radius is corrected. The run-wide form was also **asserted, never evidenced** — no measurement
  shows zero unsupported shapes is achievable across 44 providers, and only 20 of 44 were ever probed
  on a `/models` path, all unauthenticated. A run-wide gate may be adopted later **from a measured
  shape-coverage number**, which is the standard D5's successor constant is held to; it is not
  asserted ahead of the data. A partial or failed run **retains its cache**, so a re-run costs only
  the providers that failed.)*
- Report 01 — 7 call-shape clusters, A+B+C covering 41 of 47 through one code path. Six bespoke:
  `cloudflare` (405 → native `models/search`, `{result:[]}`, per-account URL, ids are UUIDs with
  names in a separate field so `idField` is unconfirmed), `agentrouter` (3 mandatory WAF headers),
  `aionlabs` (`{models:[]}` not `{data:[]}`), `youcom` + `githubcopilot` (no HTTP surface, already
  excluded by `filterRegistry`), `anthropic` (relay, never discovered). Every baseUrl is already
  version-complete — append exactly `/models`, never `/v1`.
- `keysync/key-health.mjs:41 headersFor` — already splits multi-line `headersTemplate` and
  substitutes `{key}` per line, covering clusters D and E with no per-provider code. A parser
  reading only the first line silently 401s on agentrouter.

**Known costs, not minimised:**

1. The vault has **no listing field at all** — report 01: *"pure convention — `{baseUrl}/models`"*,
   deviations living in free-text `notes`. Adding `listing` profile keys is a vault schema change,
   and `providers.json` is unsigned and user-writable (F6), so the **host allowlist must be pinned
   in code, not there**.
2. `xai` and `commandcode` want a probe, not a design decision — `commandcode`'s notes say
   `GET /models` while its baseUrl ends `/provider/v1`; `xai` is a plain cluster-A entry
   inexplicably absent from Maestro's cache.
3. 44 authenticated requests against real keys during development. Permitted — **direct fetch,
   never through the gateway** (F2) — with `redirect: "manual"`, https-only, no query string on a
   listing URL, bounded concurrency 6, and a per-provider failure budget stopping after 3
   consecutive auth failures.
4. `tabiai` and `gorouter` return `200` with `data: []` and were never chat-probed by design
   (~6,554 hidden prompt tokens at Opus pricing for tabiai). They are also the two providers that
   trip `checkBareCollisions` first once discovery populates them — see §7 item 1.

**Two settings to resolve during planning:** whether the cache lands in `~/.uw/catalog/`
(constraint 17 decided this; never built — #12) or beside `snapshot.json`; and whether the first
live run covers all 44 keys or a subset spanning clusters A/B/C plus one bespoke.

## 7. D7 — uwpick model-level menu

**Locked in intent; the rendering is a design task for planning.** Discovery plus the join make
several facts knowable that the menu currently cannot show. Two requirements.

### 7.1 Surface the capability the join now yields

**Most of this already exists and is simply unfed.** `menu/style.mjs` model-level columns are
`W = { id: 34, ctx: 6, price: 7, badge: 6, caps: 3 }`, and the caps cell (TVR — tools, vision,
reason) already renders tri-state honestly:

```js
on === true ? p[colour](ch) : on === false ? p.dim("-") : p.dim("?")
```

So `?` for unknown is already correct behaviour, not a gap. What is missing is the **data**: today
most rows carry `null` because the bundle covers only 21 of 44 providers and the join uses neither
`aliases[]` nor vendor-qualified tails. Feeding TVR and `ctx` from the §1 join moves ~80% of rows
from `?` to a real value. **This is mostly wiring, not new UI.**

### 7.2 Distinguish the row categories at a glance

New categories, and — critically — **each must be free at discovery cadence**, per the staleness
budget. Cost per label, measured:

| category | source | cost | budget |
|---|---|---|---|
| `call-verified` | a dated completion this system ran and recorded — the artifact exists (`keysync/verified-rows.json`: `generatedAt` + `working[]`, real-CLI ground truth) | already run; **not wired into the snapshot in this branch** | passes on cost; unpopulated until wired |
| `config-asserted` | vault `testModel` / the relay literal | local config read | passes |
| `listing-verified` | present in the live listing | falls out of D6's 44 calls | passes |
| `catalogue-only` / listing-absent | in bundle, omitted by the listing | free, same 44 calls | passes |
| `routable` | present in `Providers[].models` | local config read | passes |
| capability known vs unknown | the §1 join | local computation | passes |
| **404s when called** | per-model completion | ~1,588 requests, costs money, decays fast | **fails — do not label** |

Discovery is what moves listing-absence from the second class to the first. That refinement is now
recorded in the pillar itself.

**"Deprecated" is not separable from "absent"** unless a provider explicitly flags it, and most do
not. Do not invent a label with no feed — fold it into `catalogue-only` and flag any
provider-supplied deprecation field as a later enhancement.

**Render constraints the design must respect:**

- The badge column is **fully spent** on `FREE` / `FREE?` / `PLAN` / `PAID` / blank (constraint 4).
- **#3 rejected colouring the model name** — a fourth colour vocabulary on the same row.
- Colour is never the only carrier (`healthDot` uses four distinct glyphs for exactly this reason);
  any new state needs a glyph, not just an SGR code.
- Dimming is already taken: `style.mjs` dims on `routable === false || outputKind === "nontext"`.
  Overloading it with provenance makes three meanings share one signal.
- `FRAME_W` is 78 and `vis()` counts code points; any column change must keep the frame-width
  invariant and pad **before** colouring.
- uwpick is **filterable and windowed**, unlike the native `/model` menu. Filtering or grouping by
  provenance is navigation, not a label, and is not bound by the staleness budget the way an
  at-a-glance badge is — worth weighing against per-row markers.
- The live listing carries `capability: chat|audio|image_gen|embedding|vision|rerank|moderation`,
  which is a **fresher and more direct** `outputKind` source than the bundle's `modalities.output`
  — and OQ-3 records that bundle field being wrong (`nvidia/bge-m3` is an embedding model declared
  `output: ["text"]`).

---

## 8. Still open — not locked, must be settled during planning

1. **The reseller path past `checkBareCollisions`** (#9, BACKLOG item 2). D1 kills the
   false-positive class but not this: once discovery populates tabiai and gorouter, a Claude id
   sole-owned by one of them goes fatal on the main write path, and the fatal message's primary
   remedy — start the relay so it co-owns the id — is unachievable for `claude-opus-5-thinking`,
   which the relay cannot serve. Per-id vouch with a recorded reason is the shape on the table.
   **Do not resolve by widening `--allow-bare-claude-names`**, which disarms the guard globally.
2. **What curates the native 87** once routing is wide, and where that rule runs (must be upstream
   of `assertOptionsComplete`).
3. **Refresh cadence and ownership.** `refresh/cli.mjs` does not exist (`ls refresh` — absent,
   re-confirmed 2026-09-06). #17, phase B's first structural task, and the blocker under #14, #18,
   #20, #6.

   *Corrected 2026-09-06:* an earlier revision of this item added "`menu/catalog.mjs:107-110`
   asserts it does." **That is no longer true** — those lines were fixed the same day and now
   correctly name `menu/snapshot.mjs:main()` as `routableSet`'s only caller, with `:112-122`
   recording the removal and adopting a standing rule: *"this file's comments may no longer name a
   module path that does not exist."* The missing module is real; the lie is gone. Do not send an
   executor to close it — there is nothing there, and an accurate comment could get "fixed."
4. **`--verified-only` under never-prune** (#6) — it becomes a labeller and its name becomes wrong.
5. **Provenance persistence and badging** — snapshot schema and badge vocabulary are unspecified,
   and the badge column is already fully spent on `FREE`/`FREE?`/`PLAN`/`PAID`/blank.
6. **Which layer substitutes the model in #47** — ~~not yet traced~~ **TRACED 2026-09-07; this item
   is answered** *(revision 10, #74, OQ-6)*. It is **Claude Code's `env.ANTHROPIC_MODEL` winning over
   `settings.model`**, applied client-side before the request leaves Claude Code — **not** CCR's
   `Router.builtInRules["claude-code"]`, which §1.2 and §1.6 of the plan had ruled in. Measured
   read-only against the live gateway: 23 in-profile rows whose distinct `requestedModel` set is
   exactly `{anthropic/claude-opus-5, anthropic/claude-sonnet-5}` while `settings.model` was
   `anthropic/claude-haiku-4-5-20251001`, which appears in **zero** rows; `x-ccr-routed-model` equals
   `requestedModel` on all 25. **The conditional is falsified too**: the documented behaviour
   substitutes only *"when the client has not selected a recognized model"*, and
   `claude-haiku-4-5-20251001` **is** recognized and routable — it is in the gateway's own
   allowed-models list — and was overridden anyway. The override is **unconditional**.
   Full record: `plans/open-questions.md` OQ-6. **Not fixed in this branch** — R1 was read-only, and
   the remedy is a two-fields-of-`settings.json` problem, not a resolver one.
7. **`autoFetchModels: false` is not enforced** (#44). It is the enforcement point for the whole
   remote-id gate and going wide raises the cost of a silent flip.

## 9. Out of scope for this branch — deferred to later branches

Set by the user 2026-09-06. These are not "phase B someday"; they are **named next branches**. A
task that drifts into either is out of scope even when it looks adjacent.

### 9.1 Compaction and context-window work

Report 17's lane — decided (Approach A, manual two-keystroke `/autocompact`) and deliberately not
started. Everything below belongs to it:

- `/autocompact <N>` and any compaction-threshold control.
- The `[1m]` string lever, `ONE_M_TOKENS`, and anything altering what Claude Code *believes* a
  model's window to be. Recorded ceiling: CC reads one string lever and otherwise its own baked
  catalogue, so a model between 200k and 1M has no expressible value, and compaction can be lowered
  per model but never raised (`Math.min(believed, configured)`).
- `hud-shim.mjs` context reporting and `contextIndex()`.
- #19 (models compacting against a borrowed 200k window while real windows span 4,096–1,048,576),
  #20 (aggregator context over-declaration — `openrouter/mimo-v2.5-pro` declares 1,050,000 while
  the worst endpoint serves 262,144), #37.

**The one thing that stays in:** the picker's existing `ctx` column (`W.ctx = 6`). It already
renders, and D7.1 feeds it real values from the join. Displaying a catalogued context size is
metadata rendering, not compaction behaviour. **Do not** touch what CC believes, and do not add any
threshold, lever or `[1m]` logic.

#### Handoff to the compaction branch — read this before planning it

Report 17 deferred Approach A *"until the parallel `behavesAs` capability-channel scoping returns,
since both touch the picker's handoff path and the row's context data."* That scoping has returned,
so the stated blocker is cleared and the overlap it names is with **D7**, not with the resolver
core. Three facts the next branch should start from, so it does not re-derive them:

1. **Its data prerequisite ships here.** Approach A needs `N` — the model's real catalogued window
   — to write `/autocompact <N>`. D7.1 feeds `limits.contextTokens` into the `ctx` column from the
   §1 join, covering ~80% of rows. The compaction branch therefore starts smaller than report 17
   assumed: it consumes a value that already exists rather than sourcing one.
2. **D7 opens BOTH files. Re-read each; merge neither.**

   *This note has moved twice — record of the corrections, so nobody restores a superseded version:*
   revision 1 said neither file (wrong); revision 2 said `menu/uwpick.mjs` only (correct at the
   time); **issue #51 then added `menu/pick-state.mjs`.** The position below is current as of
   2026-09-06 18:05.

   - **`menu/uwpick.mjs`** — R16, the fixed `meta` literal at `:49-56`.
   - **`menu/pick-state.mjs`** — the #51 refused-id drill-in. The reducer gains exactly four
     things, and **all four are disjoint from Approach A's needs**:
     1. one nullable field, `state.refusals` = `null` or `{ provider, top }`;
     2. one binding, `ctrl+r` (`c0 === 18`, previously unbound), live only on a provider row with a
        non-zero refusal count — otherwise a no-op, never an empty overlay;
     3. one modal rule mirroring `legend`'s — swallow keys, arrows scroll, any other key closes;
     4. one projection of `refusals` into the view object beside `legend`.

     **No new level, no change to the esc ladder, no change to filtering.**

   So the compaction branch needs a **re-read of both files, not a merge**. Approach A's second-press
   state is additive to a reducer whose `@verified` filter token remains out of scope, and none of
   the four additions above touches the paths Approach A needs.
3. **Approach A splits cleanly, and the halves have different verification costs.** *A1* — the
   two-press handoff — is small and overlaps D7, but **cannot be verified by `node --test`**; it
   needs a live Claude Code session performing a real model switch. *A2* — the `PostModelSwitch`
   hook plus directory watcher (52–56ms end-to-end, session-id disambiguation, recovery when the
   watcher was down) — is a self-contained subsystem with no overlap and no live gate. Sequence
   accordingly.

**Why it was not folded in**, recorded so the decision is not silently reopened: unlike discovery,
compaction is not a dependency of anything locked here — D3 and D4 had no data source without D6,
whereas the resolver ships fine without compaction. And the widen does not regress anything by
waiting: a row that was unresolvable became `anthropic/claude-opus-5` silently, whereas after the
widen it routes to the right model with an imperfect window. Wrong model → right model with a
borrowed window is an improvement, so #19 grows in count without growing in per-row harm.

### 9.2 Subagent model assignment

Assigning specific models to subagents is its own branch. Out of scope here:

- CCR policy 2, `builtin-agent-claude-code-subagent`, and the suppression
  `if (request.builtInClaudeCodeSubagent === true) return false;` which makes the client model
  ignored for subagent requests even when it resolves.
- Any per-agent-type routing, profile tier repointing for subagents, or `ANCHOR_PREFERENCE` change
  motivated by subagent behaviour.

**Boundary note:** #47 is *main-agent* substitution — an unresolvable model falling through CCR
policy 7 to `anthropic/claude-opus-5`. That is squarely in scope and is what D4 step 1 fixes. The
user corrected an earlier misdiagnosis on exactly this point: *"it wasn't CC subagents but the agent
itself."* Fixing main-agent resolution is in; changing subagent model assignment is out.

## 10. Standing constraints that bound any implementation

- Never log, echo or write an API key into output or a report; providers by name only.
- Never run `node keysync/run.mjs --target live` without explicit authorization — it writes the
  real `~/.claude/settings.json` and restarts the CCR gateway.
- `spike/research/` is gitignored and may contain keys — never commit.
- Fetch provider listings **directly, never through the CCR gateway** (report 08 F2):
  `request_logs.url` is stored unredacted, Google's native listing carries the key in the query
  string, and capture policy is `requestLogBodyCapture: "errors"` over a population that is
  error-dominated.
- `redirect: "manual"` on every fetch; refuse non-https; refuse a query string on a listing URL.
- Never schedule a privileged write (F8) — `refresh` is cache-only and schedulable, `apply` is
  manual and diff-then-confirm.
- Never persist raw provider responses (F7/F10); allowlist projection at ingest.
- Never build a cache path from a remote id — hash it.
- 413 tests currently pass via `node --test "test/*.test.mjs"`. There is no `package.json`; that
  exact invocation is the runner.
- Pure logic is extracted as exported testable functions (precedent: `checkBareCollisions`,
  `deriveAnthropicSets`, `orderNativePickerOptions`) and new boundary logic is mutation-tested —
  that practice found real gaps twice, and #22 is the standing proof that a guard test omitting the
  production configuration is not a guard test.

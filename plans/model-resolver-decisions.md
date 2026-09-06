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
| "641 of 3,752 live rows join (17%)" | **3,046 of 3,784 (80%)** | the 17% used bare-tail matching only, and ignored the bundle's own `aliases[]` field (10,184 entries) and vendor-qualified tails |
| "~0 capable / 3,720 weak" | ~80% classified, ~20% weak | that was the live-only scenario, which D3 rejects |
| "the other 23 providers hold one model each" | **22 providers, 1,374 live models, 77% join** | the "one row" described UW's current *output* under bundle-only discovery, not those providers' inventory. `nousresearch` alone lists 390 |
| "1,281 phantoms" | ~738 unjoined of 3,784; phantom count is a separate quantity not re-measured | different denominators; the phantom set is bundle-rows-absent-from-live, measured per provider in the discovery pass |
| "`MAX_MODELS_PER_PROVIDER` bounds reach" | contributes **0 to uwpick**, but is the **sole size control on `built.picker`** *(measured; row corrected 2026-09-06)* | `menu/catalog.mjs:buildFrom` emits every catalogue entry uncapped, so uwpick's 1,588 rows are unaffected. But the same constant at `keysync.mjs:553` caps `built.picker` at 3/provider — 83 rows, 44 providers, **18 of them exactly at the cap**. See §6 |

---

## 1. The measured baseline

Sources: CCR bundled `dist/models.json` (`schemaVersion: 2`, `generatedAt: 2026-08-24T12:22:28.162Z`,
4,298 models / 217 providers, merged models.dev 2,796 + litellm 2,034 + openrouter 419, **10,184
aliases**) and `~/.maestro/model_cache.json` (live authenticated listings on the same 44 vault keys).
No network call, no key read, in-process only.

**Join ladder, over 2,136 distinct live id strings** *(measured)*:

| strategy | +hits | cumulative |
|---|--:|--:|
| exact — bare ∪ full `provider/model` ∪ **`aliases[]`** | 914 | 43% |
| normalisation (`models/`, `:free`/`:batch`, `.`→`-`) | 51 | 45% |
| case-insensitive | 38 | 47% |
| **vendor-qualified tail match** | 376 | 65% |
| + `accounts/…/models/`, leading `~`, `[…]` suffix | | **70.9%** |
| residual | 622 | 29.1% |

**Per (provider, model) pair, 42 provider roots** *(measured)*: **3,784 live pairs, 3,046 join (80%)**.
Bundle-covered providers 82%; providers with zero bundle coverage 77%. Coverage is near-uniform
once the join uses `aliases[]` and vendor-qualified tails — the bundle's *provider* coverage
barely matters.

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

### 4.1 Candidate source = live listings

Named explicitly by [[key-lifecycle-must-scale]] and [[route-max-working-models]]:

> replacing the bundled catalogue with each provider's own authenticated listing as the candidate
> source

The bundle *is* the "hand-maintained snapshot that silently goes stale" the pillar was written
against — third-party npm artifact, frozen until `npm i -g`, and a global reinstall already wiped a
local patch once (report 08 F9).

Rows are unioned and ranked by provenance (discovery-design §2):

```
call-verified  >  listing-verified  >  catalogue-only
```

- **`testModel` always survives** regardless of the listing. It is probe-verified, and listings
  under-report — catalogue-first dropped the live pass rate to 4/44.
- **catalogue-only rows are kept, dimmed, and ranked last.** Report 20 §4 class 1: model absent →
  dim, never prune. [[responding-provider-never-pruned]].

### 4.2 Capability = join to the bundle, `null` on miss

`reasoning` exists **only** in the bundle. No provider's `/v1/models` carries it — verified across
deepseek, google and openrouter, whose live rows are `{capability, display_name, id, tier}`.
So `bucketFor()` can only be fed by a join.

| condition | `behavesAs` |
|---|---|
| joins, `capabilities.reasoning === true` | capable target |
| joins, `=== false` | weak target |
| no join → `null` | weak target |

Weak-on-unknown is not degradation, it is what [[models-used-as-designed]] prescribes:

> When a model's real capability is knowable, use it rather than a borrowed default. When it is
> **not** knowable, prefer the **honest minimal assumption over a confident wrong one**.

**Never infer capability from the id string.** `-thinking`, `-r1`, `o1` in a name is a
confident-wrong. Tri-state honesty holds: `true` / `false` / `null`, never `!!` coercion.

### 4.3 Join guard

Bare names never join cross-provider. `auto`, `hy3`, `inkling`, `mistral` carry no vendor prefix
and stay `null`. This is the measured false positive that loose matching produced in the bucketing
work — `orcarouter/auto` matched `morph/auto`. Prefix present → join; absent → unknown.

### 4.4 The bundle is enrichment, never a dependency

Provenance makes the dependency explicit so a later swap — models.dev direct, or authenticated
capability listings (report 18 §9.6, *"the highest-leverage available upgrade"*, never probed) — is
a source change rather than a rewrite. A third source is **deferred**: report 18 §9.3 measured
models.dev alone as worse (25.3% of UW rows absent from it), and adding it now buys a new failure
mode before the join's ceiling is known.

## 5. D4 — widen routing first, curate the native picker second

**Locked as two steps, in this order.**

**Step 1 — widen `Providers[].models` to every discovered model.** *(measured)* 3,720 models across
45 providers is 100 KB minified; CCR builds no index over `Providers[].models` at startup
(`gatewayModels` comes from `Sd()`, virtual profiles only), so startup cost is zero. It breaks
nothing on the 15-site consumer list — `validate()`'s tie at `keysync.mjs:724-729` is a **subset**
assertion (`picker ⊆ models`), which widening *relaxes*. Independently shippable.

This is the B2 fix: ~1,501 rows currently resolve to `undefined` and fall through CCR policy 7 to
`anthropic/claude-opus-5`, which is the silent substitution in #47/#48.

**Step 2 — the native `/model` menu stays curated.** It renders 10 rows at a time with 1-row
scrolling and no filter (report 04), so it cannot hold 3,784. uwpick already renders 1,588 with
filtering and is the surface that goes wide. Narrowing the native picker touches five sites and is
a separate risk profile:

| site | why it breaks on a narrower picker |
|---|---|
| `keysync.mjs:811 reconcileUserModelPin` | deletes the user's saved pin if absent — must be fed the **routable** set |
| `run.mjs:583-586 --verified-only` | filters `providers[].models` *by* surviving picker rows — backwards coupling, must be inverted |
| `run.mjs:885-891 anchorModel` | falls back to `built.picker[0]`, silently repointing all six CCR profile tiers |
| `run.mjs:1087 assertOptionsComplete` | V7 forbids dropping a row at the write site — `options[]` is the only `behavesAs` channel, so curation must happen upstream of `built.picker` |
| `keysync.mjs:724-729` / `phase5-statics.mjs:73` | subset assertions; safe in this direction but must be re-read |

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

`keysync.mjs:532-618` builds **one** array: `models` is capped at `:553`, then feeds routing at
`:570` *and* one picker row each at `:575-618`. Measured against `keysync/built-rows.json`: **83
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

**Amended decision.** Retire the constant **from routing** — routing takes the uncapped discovered
set — and keep a **distinct, renamed** constant governing only the picker branch after the split.
`UW_MAX_MODELS` and its `NaN` defect (#5: `Number("x")` is `NaN`, and `n >= NaN` is always false,
so a non-numeric value silently removes the cap) die either way, as originally intended.

**Preferred form, if the measurement supports it:** size the picker branch by the *measured*
serialized budget rather than by an inherited magic 3. Every row moved into the picker is a row
that stops resolving through `lH()` to the maximal assumption set, so this directly shrinks D4
step 2's deferred bill instead of merely capping. `behavesAsFor` is
`BUCKET_TARGETS[bucketFor(model)]` — total by construction *(verified)* — so **every picker row is
declared**, and the undeclared population is exactly `routing \ picker`. Picker size is therefore
the dial that controls that population, not a cosmetic choice.

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
  bucket. **Zero `unsupported-shape` is a non-waivable gate** — a provider being down is a fact
  about the world, an unparseable shape is our own defect. Coverage ratio is waivable with
  `--accept-coverage-delta`; this is not.
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
| `call-verified` | `testModel` probe | already run | passes |
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
6. **Which layer substitutes the model in #47** — not yet traced. Everything about honouring a
   user's selection depends on it.
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

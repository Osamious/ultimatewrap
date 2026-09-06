# Model discovery + resolver — implementation plan

**Status: pending approval.** Branch `fix/model-resolver`. No source edits have been made.

Inputs: `plans/model-resolver-decisions.md` (D1–D7 **locked**, §0 superseded figures, §8 open items,
**§9 scope exclusions**, §10 standing constraints), `plans/phase6-discovery-design.md`,
`research/phase6/{01,08,12,20}`, `plans/open-questions.md`, `plans/BACKLOG.md` items 1–2,
`.omc/uw-issues.txt`.

**Measurement convention**, inherited from the decisions doc. *(measured)* = executed this session
against real files. *(read)* = static source reading. Unmarked figures are inherited from a cited
report and were not re-run. Figures in the decisions doc §0 are never cited.

**Revision 2 — after Architect and Critic review, verdict ITERATE.** Both reviews are folded in
below; where they disagreed, the team lead resolved it by measurement and those resolutions are
adopted here. Two changes are structural rather than corrective: **the vouch is gone** (§1.1, F2)
and **`MAX_MODELS_PER_PROVIDER` is retired from routing only** (§1.2, C1). The decisions doc was
amended four times while this plan was frozen — §0's cap row, D5, §8 item 3, and §9.1's handoff —
and every figure below is re-cited against the amended text. Superseded figures this plan carried in
revision 1 and no longer cites: `settings.json` at 7,982 bytes (**actual 23,242**), the picker at
"87 rows" (**actual 94: 83 vault + 11 relay**), and D5's "never touches the picker path" (**false of
the native menu**).

---

## RALPLAN-DR summary

### Principles

1. **State, never death.** A live-but-unpaid, bad-auth, or empty-listing provider is surfaced and
   still routed. Only categorical impossibility skips. [[responding-provider-never-pruned]]
2. **Reach beats tidiness, and reach must survive updates.** Every widening that removes a
   hand-maintained list is worth more than the same widening achieved by editing one.
   [[route-max-working-models]], [[key-lifecycle-must-scale]]
3. **Honest unknown over confident wrong.** Tri-state everywhere: `true` / `false` / `null`, never
   `!!`. Never infer capability from an id string. [[models-used-as-designed]]
4. **A label must be refreshable at a cadence that keeps it true, or it must not exist.** The
   staleness budget governs every new cell in the picker. [[uwpick-shows-latest-functional-state]]
5. **A guard test that omits the production configuration is not a guard test.** Issue #22 is the
   standing proof: 412 green tests certified a live hijack hole because every alias test passed
   `realIds: null` while `run.mjs` always passes a Set.

### Decision drivers (top 3)

1. **`checkBareCollisions` is a `process.exit(1)` on the main write path.** It is the one thing in
   this feature that can take keysync from "degraded" to "cannot run at all". Everything about
   ordering follows from it: the reseller path must exist *before* discovery populates tabiai and
   gorouter, and it must not be opened by widening the global off-switch.
2. **`Providers[].models` and `picker` are built from one array** (`keysync.mjs:532-619`, *(read)*),
   and **`MAX_MODELS_PER_PROVIDER` at `:553` is the sole size control on `built.picker`** — 83 rows,
   44 providers, 18 of them exactly at the cap. Routing wants ~3,784 rows; `modelPicker.options[]` is
   simultaneously the rendered `/model` menu *and* the only channel that can carry `behavesAs`
   (OQ-1/OQ-2), at a measured **135 bytes per row** against a `settings.json` that is **23,242 bytes**
   and parsed at every Claude Code launch. Sizing them together is what makes D4 two steps, and
   decoupling is the prerequisite for both. Deleting the constant outright — which revision 1 of this
   plan proposed — takes the native menu from 83 rows to ~1,584 and the options array past 200 KB.
3. **The bundle is enrichment; the listing is candidacy.** `reasoning` exists only in the bundle, so
   capability can only come from a join; but the bundle disagrees with the keys wholesale (deepseek
   105 vs 3, google 185 vs 55). Neither source can be dropped, so provenance is the mechanism that
   keeps the dependency explicit rather than load-bearing.

### Viable options

Only the shape of the two genuinely open choices is optioned here. D1–D7 are locked inputs.

**Option set A — the reseller path past `checkBareCollisions` (§8 item 1).**
*(Revision 2: A2 adopted, A1 dropped. Revision 1 chose A1 and deferred A2; the Architect measured
the guard against CCR 3.0.22's `resolve()` and the deferral no longer survives — see §1.1.)*

| | A2 — `fatal` from the **unstripped** owner set (**chosen**) | A1 — per-id, per-provider vouch (dropped) | A3 — widen `--allow-bare-claude-names` |
|---|---|---|---|
| Mechanism | keep the `relayOwned` stripping for **reporting**; compute `fatal` from `owners`. Two lines | `--vouch-bare <provider>/<id>="reason"`, persisted under an owner-only DACL | one boolean already in source |
| Pro | the verdict becomes **exactly CCR's own bind condition**; every false-positive fatal disappears; collapses a task, a module, a flag, a persisted security artifact, an ACL surface and an ordering constraint | narrowest possible exception; survives discovery at width | zero work |
| Con | the guard's fidelity now depends on nothing but keysync mutating `Providers[].models` — which makes **R4's V9 load-bearing rather than tidy** | a whole security artifact built to suppress false positives that A2 removes at the source | **invalidated** — disarms the guard globally, which the decisions doc forbids by name |

A3 stays invalidated by instruction. **A1 is dropped, not deferred**, and its removal is the single
largest simplification in revision 2.

**Option set B — where the native-picker curation rule runs (§8 item 2).**

| | B1 — decouple, keep `picker` at today's curated size (**chosen for D4 step 1**) | B2 — one array, cap raised |
|---|---|---|
| Pro | routing widens with zero `behavesAs` regression; `assertOptionsComplete`'s V7 is satisfied by construction because `built.picker` remains "every row the build produced *for the picker*" | no new shape |
| Con | rows that route but are absent from `picker` carry no declaration and resolve through `lH()` to the maximal assumption set — a real, countable cost (§1.2) | the cap sizes routing and declaration together, which is the defect open-questions.md already names |

---

## 0. What this plan settles, and what it deliberately does not

**Settles:** §8 items 1, 4, 5, 7 outright; item 2 *mostly* — amended D5 answers "what curates the
native picker" (a renamed successor to the existing constant), and this plan adds the ranking rule
inside it, leaving only the **size** open; item 3 partially (the module gets built; cadence stays
deferred); item 6 as a scoped read-only confirmation whose result gates the live apply.

**Does D4 step 2's sizing, and only its sizing.** The picker is already curated at 3/provider, so
step 2 is not "narrow it" but "decide how large it should be now that every row in it is a
`behavesAs` declaration". **R13b owns that decision**, gated on R11's measurement (§1.2). What stays
out of this branch is any change to *which surface* the native menu is or how it renders — step 2's
other half.

**Does not do:** any cadence, scheduling, provider health labels (#14), probe consolidation, or
per-model completion probing. D6 puts all of it in phase B and this plan honours that line.

### 0.1 The two excluded branches (decisions doc §9)

Named next branches, not "someday". A task that drifts into either is out of scope **even when it
looks adjacent**, and the two places this plan comes closest to the line are called out below so an
executor does not have to judge it.

**§9.1 compaction and context-window work is out.** No `/autocompact`, no compaction threshold, no
`[1m]` lever, no `ONE_M_TOKENS`, nothing that alters what Claude Code *believes* a model's window to
be, no `hud-shim.mjs` context reporting, no `contextIndex()`, and none of #19, #20, #37. Grep-checked
against this plan: zero references to any of them.

- **Carved in, by §9.1's own exception:** the picker's existing `ctx` column (`W.ctx = 6`). D7.1
  feeds it real `limits.contextTokens` values from the join (§2.1, R14). Displaying a catalogued
  context size is metadata rendering. Do not let a reviewer remove it as compaction work, and do not
  let an implementer grow it into one.
- **Near the line, and deliberately untouched:** `behavesAs`. Its declaration does influence a
  believed window, but this plan changes no `BUCKET_TARGETS` value, no `ALLOWED_BEHAVES_AS` entry,
  and not `CTX_CAPABLE_MIN`. R11 preserves today's per-row `behavesAsFor` behaviour across the
  routing/picker split and nothing more. Any change to what a bucket *declares* belongs to §9.1.

**§9.2 subagent model assignment is out.** No CCR policy 2, no
`builtin-agent-claude-code-subagent`, no `builtInClaudeCodeSubagent` suppression, no per-agent-type
routing, and no `ANCHOR_PREFERENCE` change motivated by subagent behaviour.

- **The boundary that matters, because issue #47's *title* records the misdiagnosis the user
  corrected** — "Subagent requests ignore the selected model". The user's correction was verbatim:
  *"it wasn't CC subagents but the agent itself."* #47's in-scope half is **main-agent** substitution
  — an unresolvable selection falling through CCR policy 7 to `anthropic/claude-opus-5` — and that is
  exactly what D4 step 1 fixes. An executor opening #47 must read past the title.
- **Near the line, and in scope:** R13's anchor assertion. It exists because `anchorModel`'s
  `built.picker[0].model` fallback silently repoints the six profile tiers when picker ordering
  changes under the widening. That is main-agent config integrity caused by this branch's own change.
  It must not become an `ANCHOR_PREFERENCE` edit or any per-agent routing.

---

## 1. Settlements for the open items

### 1.1 Item 1 — the reseller path past `checkBareCollisions` (hard blocker, #9, BACKLOG item 2)

**The mechanism, stated precisely** *(read, `run.mjs:71-233`, `run.mjs:287-317`)*. After D1 the
guard classifies an id iff `ANTHROPIC_ALIASES.includes(id) || (realIds ?? ANTHROPIC_FULL).has(id)`.
Ownership is then computed with the relay **stripped** from the owner set unless the id is
*vouched*, where `relayOwned = ANTHROPIC_FULL ∪ ANTHROPIC_ALIASES` — eight hardcoded strings that
never grow with live data (`assertVouchedSetIsNarrower` enforces exactly that).

So the residual fatal is precisely: **a real Anthropic id that the relay routes (from live
`/v1/models`) but does not curate, sole-owned by one reseller.** `claude-opus-4-8` is the named
first instance; today it is non-fatal only because tabiai and gorouter both list it and neither is
in the bundle, so both stand on one stale `testModel` each. Discovery removes that accident.

**Chosen: A2 — keep the stripping for reporting, compute `fatal` from the unstripped owner set.**

CCR 3.0.22's `resolve()`. **Revision 2 quoted only the first three lines and drew a completeness
claim from them. There is a fifth stage, and omitting it hid a live hole** (C3, now #53):

```js
let s = this.providerModelMatches(n, !1);
if (s.length === 1) return gb(s[0].provider, s[0].model, n);
if (s.length > 1) return;                    // undefined — nothing binds
let a = this.providerModelMatches(n, !0);    // case-INSENSITIVE retry — omitted in revision 2
return a.length === 1 ? gb(a[0].provider, a[0].model, n) : void 0;
```

**The `|s| === 0` branch is not a dead end.** `run.mjs:730-731` already says CCR's stages bind
*"(case-insensitive)"*; the transcription dropped its own comment's parenthetical, and I built an
argument on it without checking.

**Verified against the real guard this session, production-shaped `realIds` and `relayOwned`, relay
absent** *(measured)*:

| advertised by a lone reseller | guard verdict |
|---|---|
| `opus` | `fatal: true`, hijackable 1 |
| **`Opus`** | **`fatal: false`** — "no bare Claude-shaped collisions" |
| **`OPUS`** | **`fatal: false`** |
| `claude-opus-5` | `fatal: true` |
| **`Claude-Opus-5`** | **`fatal: false`** |

A reseller advertises `Opus`; Claude Code sends `opus`; B4 finds 0 exact matches; B5 retries
case-insensitively, finds 1, and **binds**. `RESERVED` carries the `i` flag so the shape gate passes,
but the narrowing at `run.mjs:126` uses `ANTHROPIC_ALIASES.includes(id)` and `realIds.has(id)` —
both strict-equality — so the id is skipped before it can ever be classified.

**This is pre-existing, not caused by A2.** But A2 *removes* a control while justifying the removal
with a completeness claim that was false, so the fix belongs here and lands with it.

**The case analysis, which I worked through independently before adopting this.** For an id outside
`ANTHROPIC_FULL ∪ ANTHROPIC_ALIASES` (i.e. unvouched), with `owners` = the enabled providers listing
it and `effective` = `owners \ {relay}`:

| `owners` | guard today (stripped) | guard under A2 (unstripped) | what CCR does |
|---|---|---|---|
| `{tabiai}` | hijackable → **fatal** | hijackable → **fatal** | `length === 1` → **binds to tabiai** |
| `{relay, tabiai}` | `effective = {tabiai}` → **fatal** | size 2 → `shadowed`, not fatal | `length > 1` → **returns `undefined`** |
| `{relay}` | `effective = {}` → skipped | size 1, relay ∈ owners → skipped | binds to our own relay |
| `{tabiai, gorouter}` | `shadowed` | `shadowed` | `undefined` |

**The stripping changes the verdict in exactly one row — the second — and that is the row where CCR
already refuses to bind.** Every fatal it adds is a false positive. And it can never *remove* a true
positive: if `|owners| === 1` and the relay is not among them, stripping removes nothing, so the id
stays hijackable. So the unstripped set is **exactly CCR's bind condition — under R0's two-stage,
trimmed ownership computation**, and only under it *(M15: revision 2 wrote this sentence unqualified,
which was the claim C3 and A1 falsified; with exact-then-fold matching and `.trim()` on both sides it
is true again, and the qualifier is what keeps it true)*. The guard's verdict then states what CCR
will actually do rather than proxying for it.

**As shipped, this is now true unconditionally** *(B1, measured)*. Before the entry-counting fix the
qualifier still concealed a gap: ownership counted **providers** while `resolve()` counts **matching
entries**, so `|owners| === 1` was not in fact CCR's bind condition wherever one provider matched
twice (`Opus` + `OPUS`), a provider listed an id twice, or two providers shared a name. With R0's
accumulator counting entries, `length === 1` **is** `s.length === 1`, and the sentence needs no
escape clause. L16 and F3 in Ship 0's residual list are retired by the same fix.

**The threat I failed to construct was a threat to A2 specifically, not to the guard** *(M15)*.
Revision 2's *"I could not construct a threat that survives"* stood fifty lines below its own
correction and read as a general clearance; it was not one. **C3 and A1 are both threats that
survived it**, found by reviewers, and both were live on `main` rather than introduced by A2. What the
analysis below actually establishes is narrower and still holds: *given* faithful ownership, removing
the `relayOwned` stripping from the `fatal` computation adds no reachable hijack. The strongest
candidate for that narrower claim is the relay dying between
the keysync write and the request, leaving the reseller effectively alone — but `providerModelMatches`
gates on `enabled`, a **config** property, not on liveness. A dead relay stays an owner in the config
CCR reads, still yields two matches, still returns `undefined`. The guard reads the same config, so
fidelity holds. And when keysync runs with the relay *down* (or `--no-anthropic`), the relay is never
unshifted into `built.providers` at all, so `owners = {tabiai}`, row 1 applies, and the genuine
report-08-F1 hijack is caught identically under both schemes.

### 1.1a The ownership computation is rebuilt around the selector, not the advertised id

**This half ships first and alone, as Ship 0 / R0** — #53 is live on `main`, and at iteration 3 of a
maximum 5 with no implementation started, it had no reason to wait on the rest of the plan. §1.1's
correction of the transcription and its completeness claim, and H5's dead-branch cleanup, stay with
A2 in R7. The measurement showing the two halves are genuinely separable is in R0.

**Stop iterating advertised ids.** Today `byBare` is keyed by whatever string a provider advertised,
which is why a case variant never becomes a key at all. Iterate instead the **classification set** —
`ANTHROPIC_ALIASES ∪ (realIds ?? ANTHROPIC_FULL)`, i.e. the selectors Claude Code can actually send —
and for each selector compute ownership the way `resolve()` does:

1. the **exact** owner set;
2. **only if that is empty**, the **case-insensitive** owner set.

**Neither single-case keying is correct on its own, and I confirmed the counterexample rather than
taking it on trust** *(measured)*. With `tabiai` advertising `Opus` and `gorouter` advertising `opus`
and no relay: a case-insensitive-only rewrite sees two owners for `opus`, calls it `shadowed`, and
reports safe — but B4 finds **exactly one exact match** (`gorouter`) and binds. Today's exact-keying
happens to get this one right. Each keying is wrong on the case the other handles, so both stages
must be modelled, in order, because that is what `resolve()` does.

**What is kept, and what A2 strands** *(H5)*. Revision 2 claimed *"the stripping still computes the
reported distinction, so the finding can still say the relay routes this id but does not curate it."*
**That is false as written**, and I should have checked it: `hijackable` fires only when the relay is
**absent** from the owner set, so `h.relayRoutes` is structurally always `false`, the
routes-but-does-not-curate suffix at `run.mjs:216` is unreachable, `routedNotVouched` at `:198` is
always empty, and the third remedy branch at `:204-209` is dead code.

**Resolution: move the distinction to where it is now true.** A relay that routes an id it does not
curate produces a **`shadowed`** finding, not a hijackable one — so the note belongs on the shadowed
message. R7 therefore does three things: relocates that wording, and **deletes** `routedNotVouched`
and its remedy branch rather than leaving two dead branches for the next reader to disprove. Dead
code that looks like a control is worse than no control, because it reads as one.

`assertVouchedSetIsNarrower` is kept and its assertions are unchanged — but its doc comment opens
*"The one invariant that keeps `checkBareCollisions`' FATAL path reachable"*, and under A2 that is
**false**: the fatal path is reachable by construction, being CCR's own condition. Correcting that
comment is a deliverable of R7, not an optional tidy — leaving it would hand the next reader a
confident, wrong account of what the invariant protects, which is the exact failure mode
`menu/catalog.mjs:112-122` adopted a standing rule against.

**What this costs, stated plainly.** There is no longer a per-id escape hatch — only the global
`--allow-bare-claude-names`. That is acceptable *because* the false positives are gone: the flag is
now reachable only for a configuration where CCR would genuinely bind Claude Code's bare id to a
reseller, which is the hijack itself. Blocking that is correct, and a deliberate operator override of
a real bind is exactly what a global flag should mean. Under A1 the flag's semantics were dishonest —
it was mostly being reached to silence false alarms.

**The new dependency, and it must be sequenced.** A2's fidelity holds only while nothing but keysync
mutates `Providers[].models`. `autoFetchModels: true` breaks that by letting CCR discover models
itself, straight past `admitRemoteModels` and invisible to the guard (#44). **R4's V9 is therefore
load-bearing under A2, not tidy**, and it already sits in Ship A ahead of Ship B. This is recorded as
a hard dependency in R7 and in §3.

**§8 item 1 is settled by this, more cleanly than by A1.** Item 1's complaint was that a Claude id
sole-owned by a reseller goes fatal while the message's primary remedy is unachievable. Under A2 the
fatal fires only when CCR would bind — so it is never spurious — and the existing `relayHelps` /
`routedNotVouched` message logic already withholds the "start the relay" advice when the relay does
not serve the id. Nothing further is needed.

### 1.2 Item 2 — what curates the native picker, and where

**Settled: the curation rule runs inside `buildProviders`, as a split rather than a filter; the cap
is retired from routing and a renamed successor keeps governing the picker; and the native picker is
not *resized* in this feature.**

*(Revision 2, per amended D5. Revision 1 said "retire the cap" without qualification, which both
reviewers independently flagged as unimplementable — C1/F1. The constant at `keysync.mjs:553` is the
sole size control on `built.picker`; deleting it takes the native menu from 83 rows to ~1,584, and
ranking without a cap cuts nothing.)*

`buildProviders` continues to return `{providers, picker, notes}`. After the split:

- `providers[].models` = **every discovered model**, admitted and sanitised. **No cap** — this is
  what D5 retires.
- `picker` = the curated subset, governed by a **distinct renamed constant**
  (`MAX_PICKER_MODELS_PER_PROVIDER`), **keeping today's value of 3 and today's ranking** in R11, so
  that task changes routing and nothing else. **Provenance ranking arrives in R13b**, together with
  the sizing — the two decisions both govern which rows carry a declaration, and R13b is the task
  that has a cache to rank from (§4/R13b, G2).

**`localeCompare` is not in the sort and this plan must stop citing it** *(A4)*. `keysync.mjs:545-546`
has exactly **two** terms — free-first, then `a.m.model.length - b.m.model.length` *(read)*.
Constraint 21 wanted a third added "in one deliberate run"; it never was. Revision 3 cited a
three-term sort in three places as though it ships, which is unactionable in both directions: an
executor reading "exactly as today" omits it and contradicts the list, and one reading the list adds
it — and constraint 21 says adding it **reselects rows**, breaking R11's byte-identical criterion from
the other side.

**Decision: the third term is NOT added anywhere in this plan.** R11 keeps the two live terms plus
R3's `outputKind` guard; R13b prepends provenance. A deterministic tiebreak for equal-length ids is a
real gap and belongs to constraint 21's own deliberate run, not to a task whose criterion is that
membership did not move.

**The residual that decision leaves, recorded so a future move is not misread** *(revision 5)*: with
two terms, **equal-length ids tie and resolve by bundle input order**. That is deterministic within a
session, so R11's before/after criterion is safe — but a **bundle reinstall can move picker membership
with no code change**, and report 08 F9 records a global `npm i -g` silently wiping a local patch
once. If picker membership shifts after a CCR upgrade, look at the bundle before looking at R11.

`UW_MAX_MODELS` and its `NaN` defect (#5) die regardless: `Number("x")` is `NaN` and `n >= NaN` is
always false, so a non-numeric value silently removes the cap. The renamed successor takes a
validated integer or the default, never a bare `Number()`.

**Why the picker keeps its current size *in R11*, and who sizes it.** Amended D5's preferred form —
size the picker by the measured serialized budget, because every picker row is a `behavesAs`
declaration and the undeclared population is exactly `routing \ picker` — is right. R11 holds the
picker at 83+11 anyway, so the widening can be reviewed as a **pure routing change with a falsifiable
no-op criterion on the declaration channel**. That review boundary is worth keeping.

**But the sizing is not deferred to an unowned step.** Under D4 step 1 the declared set stays at 83
while routing goes to ~3,784, so the undeclared population — every row resolving through `lH()` to
the maximal assumption set plus an unknown-model launch warning — goes from a handful to thousands.
The thing that shrinks it is exactly this sizing. So it is **R13b**, the last task in Ship D, gated on
R11's printed measurement and reviewed on its own. An unowned follow-up is how `refresh/cli.mjs` came
not to exist, and #17 is still open because of it.

R11 proves the widening changed no declarations; R13b then changes them **deliberately**, with its
own criterion. If the measurement justifies only 83, R13b lands 83 — with a stated reason instead of
an inherited constant, which is a real outcome rather than a failure.

This satisfies `assertOptionsComplete` V7 **by construction**: V7 asserts that every row the build
produced for the picker reached `options[]`, and `built.picker` is still exactly that set. No rule is
weakened and the write site is untouched.

**The cost, priced rather than asserted away.** Rows present in `providers[].models` but absent from
`picker` carry no `behavesAs`, and report 18 §3 measures an undeclared id as resolving through
`lH()` to the *maximal* assumption set — strictly worse than any bucket target. That is the whole of
D4 step 2's bill, and it is why step 2 is not paid here.

Two things make step 1 a clear improvement anyway:

- Those rows do not route at all today. Degraded-but-working beats not-working under Principle 1.
- The status quo for them is worse than "undeclared": ~1,501 rows resolve to `undefined` and fall
  through CCR policy 7 to `anthropic/claude-opus-5` — the **silent substitution** in #47/#48. A loud,
  declared-maximal route replaces a silent wrong-model answer.

**This is now corroborated in the vendor's own words**, not inferred from behaviour. CCR's routing
documentation describes the built-in Claude Code route as detecting requests from Claude Code and
routing **main** requests to the Claude Code Agent Config model *"when the client has not selected a
recognized model."* That is policy 7 stated by its author, and the operative phrase is **recognized**:
the ~1,501 unresolvable rows are the documented *cause* of the substitution, not a symptom of it. It
also fixes the direction of the remedy — widening the recognized set is the fix, so D4 step 1 is not
a workaround for #47 but its root-cause repair. (Confirmed alongside: v3.0.22 is current, and the v1
router fields are gone from both docs and source. Nothing in this plan references them.)

**The reframing that should govern step 2 when it is scoped:** `modelPicker.options[]` is not "the
menu", it is **the declaration registry**. Its size should be set by the `settings.json` parse budget
(F3b/F11), and its *ordering* — Anthropic first, then provenance — is what makes the 10-row native
menu usable. The measurements step 2 starts from, all *(measured 2026-09-06)* and replacing the
7,982-byte figure revision 1 inherited: `settings.json` **23,242 bytes**; `modelPicker.options`
**12,735 bytes over 94 rows**; **135.5 bytes/row**; `built-rows.json` **83 rows over 44 providers,
18 of them exactly at the cap**, those 18 holding 1,555 catalogue entries between them.

### 1.3 Item 3 — refresh ownership (partial)

**Settled:** `refresh/discover.mjs` and `refresh/cli.mjs` are built, manual-invocation only.
`cli.mjs` is a **cache-only** entry point: it never touches `settings.json`, `config.sqlite`, or the
gateway (F8's split).

**Correction, revision 2 (M6/L10).** Revision 1 justified this as closing a "standing lie" at
`menu/catalog.mjs:107-110` naming a `refresh/cli.mjs` that does not exist. **That comment was fixed
on 2026-09-06** and now correctly names `menu/snapshot.mjs:main()` as `routableSet`'s only caller,
with `:112-122` recording the removal and adopting a standing rule that the file's comments may no
longer name a module path that does not exist. The **missing module is real** *(measured: `ls
~/.uw/refresh` → absent)*; the lie is gone. **Do not send an executor to close it** — there is
nothing there, and an accurate comment is exactly the kind of thing that gets "fixed" by someone
acting on a stale instruction.

**Deferred:** cadence, scheduling, health labels, probe consolidation. **Unblocker:** a decision on
scheduling under F8 — nothing may be put on a timer that holds a key or writes a privileged file.

### 1.4 Item 4 — `--verified-only` under never-prune (#6)

**Settled: it stops touching `built.providers` entirely.** Today `run.mjs:583-586` filters both
`built.picker` and `built.providers[].models` *(read)*, which is the never-prune violation #6 files
and is also the backwards coupling D4 step 2's table names (routing filtered *by* surviving picker
rows). Under the §1.2 split, routing and picker are independent, so the flag becomes a picker-side
labeller/orderer and routing keeps every discovered model.

Two consequences to carry: the count branch at `run.mjs:715-717` can return to the normal
`EXPECTED_PROVIDERS + (anthropicOn ? 1 : 0)` expression, and the floor guard at `run.mjs:591-594`
still applies to `built.picker` alone. **Renaming the flag is deferred** — its name becomes wrong,
which is #6's own observation, but a rename is a separate, purely cosmetic change.

### 1.5 Item 5 — provenance persistence and badging

**Settled.** Snapshot `SNAPSHOT_SCHEMA` bumps **2 → 3**, adding a per-model
`provenance: "call-verified" | "listing-verified" | "catalogue-only" | null` and a top-level
`discoveredAsOf` stamp. The bump forces a rebuild via `loadSnapshot`'s existing schema branch, which
is the mechanism that stops an old file rendering silently wrong.

**The badge column is not touched.** It is fully spent on `FREE`/`FREE?`/`PLAN`/`PAID`/blank
(constraint 4). Provenance gets its own gutter — see §2.

### 1.5a The producer, which revision 1 named nowhere (C2)

Revision 1 added `provenance` to the snapshot schema and to `style.mjs`, and **nothing computed a
value**. The Critic caught it by asking "does anything produce this?" rather than "is the field named
at a write site", and the team lead verified it: `buildFrom({chosen, providers, catalog, relay,
cadenceOf, routableOf})` has **no discovery input**, and candidates come solely from
`catalog.byProvider`. A key literal copying `m.provenance` would copy `undefined` forever — shipping
a blank column and a header stamp that reads `undefined`, which is the `routableAsOf` failure
(B3/OQ-4) reproduced by the very plan that cites it as a lesson.

**Two distinct gaps, and revision 1 addressed neither:**

1. **No provenance value.** Fixed by mirroring the `routableOf` pattern exactly, because it is the
   pattern this codebase already uses for "a value the refresher resolved, injected into a pure
   builder": a `provenanceOf(provider, id)` predicate injected into `buildFrom`, **defaulted
   `() => null`**, supplied by `snapshot.mjs:main()` alongside `routableOf` from the discovery cache.
2. **No listing-only candidates.** Deeper, and revision 1 missed it entirely: `buildFrom` enumerates
   `catalog.byProvider`, so a model that appears **only** in a live listing never becomes a row at
   all — and those are precisely the `listing-verified` rows the provenance column exists to
   distinguish. So `buildFrom` also takes a `discovery` input, shaped like `catalog`
   (`{byProvider: Map<provider, {outcome, models: [{id, capability}], at}>}`) and **defaulted to an
   empty Map so every existing test keeps working unchanged**. Candidates become
   `union(discovery ids, catalogue ids, testModel)`; provenance falls out of which sources named the
   id; capability comes from the join.

**Second-order defect, verified by the team lead and worth stating because it is invisible in
review:** `snapshot.mjs:49` coalesces `routableAsOf ?? null`, but the per-model literal at `:54-63`
does **not** — so `JSON.stringify` drops an `undefined` key entirely and the field is **absent**
rather than `null`. Absent and `null` render identically today but are not the same thing to a schema
check or a reader. The new fields take `?? null` at the serialization site.

### 1.6 Item 6 — which layer substitutes the model in #47

**Largely settled by the vendor documentation cited in §1.2; what remains is confirmation, not
discovery.** #47's open question 1 offered two candidates — Claude Code's `ANTHROPIC_MODEL`
precedence over `settings.model`, or CCR's `Router.builtInRules["claude-code"]`. The routing
documentation names the second: the built-in Claude Code route sends **main** requests to the Agent
Config model when the client has not selected a *recognized* model. `Router.fallback` is `mode:
"off"`, so it was never that.

R1 therefore shrinks to **one live confirmation**, because documentation is not a measurement and
this is the fact pre-mortem scenario 3 rests on. It can run immediately; nothing blocks it.

**Two of #47's three open questions are out of scope and R1 must not chase them:**

- **Q2 — "does the statusline show the real model or the believed one?"** `hud-shim.mjs` context
  reporting is §9.1. Out.
- **Q3 — "should the picker refuse to pin an unroutable model?"** That reopens D9 and is #48's
  territory, not this branch's. Out. The standing rule still forbids blocking on a perishable
  measurement.

### 1.7 Item 7 — `autoFetchModels: false` is not enforced (#44)

**Settled: a new `validate()` rule, V9, in this feature.** Widening raises the cost of a silent flip
precisely because auto-fetch would put provider-declared ids into `Providers[].models` *without*
passing `admitRemoteModels`, so `checkBareCollisions` would never see them. One rule, one message
naming what it protects, one test. Cheap, and it is the rule family the codebase already uses.

### 1.8 D6's two unresolved settings

**`ensureBackupDir`'s DACL does not transfer, and revision 1 assumed it would** *(F5)*. It applies
only on **first directory creation** (an `existsSync` guard) and it **swallows an `icacls` failure**
— both justified for its current contents, which are DPAPI-encrypted at rest. A discovery cache is
plaintext and is a provider-holdings inventory (F7), so it has neither property. The vouch file this
finding was originally aimed at is gone with A1, but **the finding survives and now applies to the
discovery cache**: apply and **verify** the ACL on every write, and **refuse at read time** if the
file is not owner-only. A silently-unprotected inventory is worse than an obviously-absent one.

**Cache location: `%LOCALAPPDATA%\uw-keysync\discovery\`, with that verified owner-only DACL.** Not
`~/.uw/catalog/`. Constraint 17 decided that `~/.uw/catalog/` holds the *bundle copy* — a public npm
artifact — which is a different asset class from a discovery cache. F7 rates the cache a
**provider-holdings inventory** ("maps exactly which services hold paid credentials and which are
live") and F13 says to reuse the `%LOCALAPPDATA%\uw-keysync` pattern with an explicit DACL. `catalog/`
is gitignored *(measured: `.gitignore:36`)* so nothing would be committed, but gitignore is not an
access control and `~/.uw` is a repository.

**First live run: staged.** `refresh/cli.mjs` takes `--only <provider>[,…]`. The smoke run covers one
provider from each of clusters A, B and C plus **agentrouter** (cluster D — the multi-line
`headersTemplate`, which is the one parse whose failure is a silent 401). The acceptance run covers
all 44 eligible, because rule 3 requires exhaustiveness and a subset cannot report coverage. Both are
manual, and both need the user's explicit authorization before any authenticated call is made.

---

## 2. D7 — the uwpick model-level rendering design

### 2.1 What §7.1 asks for is wiring

`menu/style.mjs`'s caps cell already renders tri-state honestly
(`on === true ? p[colour](ch) : on === false ? p.dim("-") : p.dim("?")`, `style.mjs:342-343`,
*(read)*). `?` for unknown is correct behaviour, not a gap. What is missing is data: the join in
`menu/catalog.mjs:buildFrom` reads `catalog.byProvider.get(cred.provider)` and nothing else, so it
uses neither `aliases[]` nor vendor-qualified tails. Feeding TVR and `ctx` through the D3 join is
the whole of §7.1 and touches no rendering code.

One data-precedence rule rides along, and it fixes OQ-3 for free: **where a live listing supplies
`capability`, it takes precedence over the bundle's `modalities.output` for `outputKind`.** The
listing's `capability: chat|audio|image_gen|embedding|vision|rerank|moderation` is fresher and more
direct, and the bundle is measurably wrong in this exact field — `nvidia/bge-m3` is an embedding
model declared `output: ["text"]`.

**`outputKind`'s own rule is NOT changed, and #54 is withdrawn as filed** *(revision 5)*. The
tempting inversion — treat `["audio","text"]` as non-text — **demotes every omni chat model**: all 109
text+generative entries have text input and are overwhelmingly omni models like
`alibaba/qwen-omni-turbo` (`in: ["audio","image","text","video"]` → `out: ["audio","text"]`). The
input-based alternative fails for the same reason: `lyria-3-pro-preview` is `in: ["image","text"]`,
indistinguishable, because **every generator takes a text prompt**. `modalities.output` is an
unordered set recording what a model *can* emit, not what its product is, and **no rule over this
schema separates the two**. Both reviewers tested and withdrew their own proposals; one additionally
measured `toolCalling` as dead for this purpose — `false` on 25.7% of the ambiguous set against 12.6%
of pure-text models, a correlate rather than a discriminator, and gating on it would demote **477**
genuine chat models.

**What ships instead is a comment.** Record the blind spot in `outputKind`'s own doc, with the
lyria/qwen pair as the worked example, so the next reader does not re-derive the inversion and ship
it. The 374 pure generators are all correctly caught today; the residual is the mixed-output set, and
the real fix is the live `capability` field above, not a schema rule.

**A curated deny-list of generator families is explicitly rejected.** It is
`MAX_MODELS_PER_PROVIDER` in a new costume — a hand-maintained list that goes stale — which
[[key-lifecycle-must-scale]] rules out and which this branch exists to retire.

### 2.2 The measurement that decides §7.2

*(measured this session, by rendering a real model-level frame through `style.mjs:frame`)*:

```
│▶ openrouter/anthropic/claude-opus-4  200k   15.00  75.00  PAID  T-?        │
 ^                                                              ^   ^^^^^^^^
 mark+id(34)          ctx(6) $in(7) $out(7)                  badge(6) TVR(3)
```

The row body spends **68 of `INNER` = 75 columns. Seven are spare.** The badge column being fully
spent is therefore not the binding constraint — the design does not need to reuse a cell, it needs
to spend width that already exists.

The same measurement surfaced a second finding — truncation — but **my fixture understated it and
the real population changes the remedy** (issue #49). `openrouter/anthropic/claude-opus-4.1` was an
id I *constructed* to drive the render, not one observed in the snapshot; I flagged that, and the
team lead then measured the actual population *(measured 2026-09-06)*:

| | today (`W.id` 34) | at `W.id` 37 | at `W.id` 41 |
|---|--:|--:|--:|
| flat targets truncated, of 1,588 | **222 (14%)** | 119 | 49 |
| rows rendering as **identical strings** | 67, in 24 groups | **38, in 15 groups** | — |
| projected at width, of 4,419 | **1,601 (36%)** | — | — |

Worst case is **57 code points** (`google/gemini-live-2.5-flash-preview-native-audio-09-2025`), and
seven distinct `deepseek/deepseek-r1-distill-qwen-*` variants collapse to one rendered string.

**So width is the wrong instrument and the gutter is not competing with the fix.** No plausible
column closes a 57-code-point id, and the failure that matters is not "text is cut" — it is **two
different models rendering as the same row**. A wider column reduces the frequency; it cannot fix the
class.

There is a paired defect in the same cell: `pick-state.mjs` filters the **full** target while
`style.mjs:373` highlights **after** `pad`, so a match beyond the cut is invisible. Measured:
filtering `instruct` returns 144 rows of which **39 show no visible match**; `thinking` returns 62
with **22 blind**.

### 2.3 The design

**A two-column provenance gutter immediately left of the id, mirroring `healthDot`'s gutter at the
provider level; and `W.id` 34 → 37.**

```
W = { …, prov: 1, id: 37, ctx: 6, price: 7, badge: 6, caps: 3 }

row = mark(1) space(1) │ prov(1) space(1) │ id(37) ctx(6) space(1)
      $in(7) $out(7) 2sp badge(6) T(1)V(1)R(1)              = 73 of 75
```

Two columns held in reserve, deliberately. The previous draft of this arithmetic in `style.mjs`'s own
comment (`INNER = FRAME_W - 4`) was wrong by one and every line came out at 77 against a test
asserting 78; leaving zero slack invites the same class of failure on the next addition.

**Why a gutter and not a cell.** `healthDot` already establishes "a one-glyph status marker in a
two-column gutter, at a fixed x, read down the column" as this picker's grammar for row status — at
the provider level. Reusing the grammar at the model level costs no new vocabulary. It also touches
neither the id cell (where `highlight` operates), the badge cell, nor TVR.

**Glyphs — a monotone confidence ladder, one column in both sets, colour never the sole carrier:**

| provenance | UNI | ASCII | colour | established by |
|---|---|---|---|---|
| `call-verified` | `◆` | `#` | grn | a real completion returned 200 (`testModel`, `verify-cli.mjs`) |
| `listing-verified` | `◇` | `+` | cya | the provider's own keyed listing named it |
| `catalogue-only` | `·` | `.` | dim | only bundle metadata names it |
| `null` (never discovered) | ` ` | ` ` | — | no discovery run has covered this provider |

**The relay's four models are `call-verified`, not `null`, and getting this wrong inverts the whole
column** *(A6, #45)*. `anthropic` is `listing: null` and is never discovered (R9), so a naive
`provenanceOf` returns `null` for it and R16 renders **blank — the bottom of a ladder whose top is
`◆`**. The four Claude models the user certainly has would then render *less* confident than a
third-party row marked `◆`, which is the exact inversion #45 already files against the picker.

`Object.hasOwn` catches a missing field, not a misleading value, so no R14/R15/R16 observable fails on
it. The justification is the one already in `menu/catalog.mjs`'s relay branch, which hardcodes
`tools/vision/reason: true` under the comment *"Every other all-true or all-false literal here was a
coercion; this one is a measurement."* The same argument applies: these are the subscription models,
known first-hand. **R14 assigns them `call-verified` explicitly, and R16 asserts a relay row does not
render blank.**

Filled → hollow → dot → blank is a legible ladder with `caps.colours === 0`, which is the
requirement `healthDot`'s own comment states and the requirement its predecessor failed. **The
implementer must confirm each glyph measures one column under `vis()` and that
`test/style.test.mjs`'s exact-`FRAME_W` invariant still holds** — `◆`/`◇`/`●` are East-Asian
*Ambiguous* width, a risk this codebase has already accepted for `●◐○` but which must not be
extended without checking.

**`padId` — middle elision preserving the tail, one code point of cost** *(revision 2, F3/#49)*.

A trailing "…" marker announces truncation but leaves the 38 identical-rendering rows identical, so
it fixes the symptom and not the class. Middle elision fixes both at the same price:

```
deepseek/deepseek-r1-distill-qwen-1.5b   ->   deepseek/deepseek-r1-distil…qwen-1.5b
```

The head keeps the row findable; the tail keeps `:free`, `:batch`, `-thinking` and the version
discriminators that are exactly what distinguishes the collapsing groups. Cost is one code point,
identical to a trailing marker, so the frame arithmetic above is unchanged.

Three implementation constraints, each of which would otherwise silently break something:

- **The marker must be exactly one code point in both glyph sets**, because `vis()` counts code
  points. **`g.ell` cannot be reused**: its ASCII form is `"..."`, three code points, which would put
  every ASCII row two columns over and fail the frame invariant.
- **The ASCII marker must be a character the glyph table does not already use** *(G6)*. Revision 2
  proposed `>`, which is already **both** `marker` and `sep` — elision would make three meanings.
  The reviewer's suggested `~` is **also taken**, by `recent`. Rather than pick a character here and
  have it collide again the next time the table grows, the rule is mechanical and testable: **assert
  that the elision marker is not a value in the ASCII glyph table.** `<`, `^`, `%`, `!`, `=`, `&`,
  `?`, `:`, `;` are free today; the test, not this sentence, is what keeps it true.
- **Elision must remain visible in the degraded rendering**, i.e. with `caps.unicode` false *and*
  `caps.colours === 0`. This is `healthDot`'s standing discipline — never let one glyph set or colour
  be a state's only carrier — applied to the one cell where the consequence is two different models
  reading as the same row.
- **The head/tail split is derived from the collision measurement, not chosen.** The acceptance
  criterion is behavioural: **zero pairs of rows within a provider group rendering as identical
  strings** over the measured 1,588, or the residual named and justified.
- **Highlight must run after elision, on the elided string**, and a match that fell inside the
  removed middle must still be signalled — colour the elision marker itself. That is zero extra
  width and it closes the 39-blind-of-144 case directly.

`W.id` still goes 34 → 37. It is free within the seven spare columns and it cuts the truncated
population from 222 to 119, but it is a **mitigation, not the fix** — elision is the fix.

**Blank must be disclosed, not implied.** `null` renders as ground, and a reader cannot tell
"nothing was discovered" from "nothing has been discovered *yet*". So the model-level header gains a
`discovered <date>` stamp beside the existing `N of M`, exactly as `routableAsOf` discloses the
unresolved-routability case. This is the OQ-4/B3 lesson applied at the point of introduction rather
than rediscovered: the disclosure that makes a failure visible must itself be wired, or it becomes
part of the failure. Level 0's header is unchanged — it is already carrying four segments at 78
columns.

**Dimming is not touched.** `style.mjs:399` keeps its two existing meanings
(`routable === false || outputKind === "nontext"`). Overloading it with provenance would make three
meanings share one signal, which the constraints forbid, and the gutter makes it unnecessary.

**Name colouring stays rejected** (#3). Bold is additionally unavailable: `highlight` already spends
it on the filter match *inside* the id cell (`style.mjs:130`, applied at `:373`), so bolding the id
would erase the highlight.

### 2.4 Per-row marker versus filtering, weighed

Filtering and grouping are **navigation**; a marker is a **label**. They answer different questions
and neither substitutes for the other: a filter answers "show me only the verified ones", a marker
answers "what is *this* one" at the moment of choosing. The marker is the primary instrument here
because provenance is a property of every row and the user's question at selection time is per-row.

The staleness budget is what makes the marker legitimate at all, and it passes cleanly: all three
levels fall out of the **same 44 discovery calls** that D6 already makes. Nothing in the ladder
requires per-model completion probing, which is the label the budget rejects (~1,588 requests, costs
money, decays in days).

A `@verified`-style filter token is a genuinely good complement and is **still out of scope**, but
the reason has narrowed. It is no longer "that file is a different lane" — #51's drill-in opens
`menu/pick-state.mjs` (R18). It is that a provenance *filter token* is a change to how filtering
parses input, which is a different mechanism from a modal overlay and is not what §7.1/§7.2 asks
for. Recorded as a follow-up, now a cheaper one than it was.

---

### 2.5 Refusal disclosure (#51) — a restriction the user can see and inspect

**The defect, verified this session.** `menu/denylist.mjs:127-145` returns `{kept, rejected}` and
**no UW source reads `rejected`** *(measured: `grep -rn "\.rejected" --include=*.mjs` outside `test/`
returns only gitignored CCR vendor scratch)*. The routing path emits one stderr `console.warn` capped
at the first 10 names; the display path passes `{warn: false}` and is silent; nothing persists. In
uwpick a **refused** model is indistinguishable from one the provider never offered.

That is a capability restriction with no disclosure, which [[route-max-working-models]] and
[[uwpick-shows-latest-functional-state]] both forbid without irrefutable evidence. It is live, not
hypothetical: `admitId` refuses **14 distinct real, safe ids** today (**40 distinct (provider, id)
pairs** — the same ids resold by several providers; both units are correct and R2's criterion counts
the 14) — 13 floating aliases
(`~z-ai/glm-latest`, `~anthropic/claude-opus-latest`) and `kimi-k3[1M]` — with **zero dangerous ids
among them**. R2 admits those 14; #51 is what makes the *remaining* refusals visible.

**Three requirements, and none of them is a render tweak.**

**(a) A persistent provider-level column.** **Corrected — revision 2's figure was wrong** *(G4/M12)*.
The level-0 row **allocates** `2 + 30 + 7 + 3 + 6 + 1 + 11 + 1 + 1 + 8 = 70 of 75`, so there are
**5 spare, not 11**. My 64 measured *ink* on a favourable row: `pad(r.health, 8)` renders `"ok"` and
inks 2 of its 8 columns, and my trailing-space trim counted the other 6 as spare. The same technique
is valid at level 1 only because TVR always inks its full 3 — which is why that 68-of-75 figure
stands and this one did not.

So `W.refused = 3` plus a one-column gap after `health` lands at **74 of 75, with 1 spare** — it
still fits, but the headroom is a quarter of what revision 2 claimed, and §2.3 reserves two columns
at level 1 deliberately while this leaves one. Implementers should treat level 0 as effectively full.
**Blank when zero**, so the column is quiet on a clean provider — positive-signal-only, the same
discipline `capsOf` and `makeRoutableOf` already follow. The header gains `refused` derived from the
same `W` constants as the row, as `menu-layout`'s derived-offset test requires.

**(b) A drill-in from inside the menu.** **ctrl+r (`c0 === 18`)** on a focused provider row.
*(measured: bound control codes are 3, 6, 8/10/13/27/127 — 18 is free.)* A plain letter cannot be
used: level 0 sends `a-z0-9` to the filter, which is exactly why `ctrl+f` is a control key. The
detail is a **modal overlay in the `legend` pattern**, not a third navigation level — `frame()`
already renders one modal from `v.legend`, dismissed by any key, and reusing that grammar costs no
new interaction model. Windowed with the existing `… N more` line if a provider ever exceeds the
frame.

**(c) Per refused id: the id as advertised, and the specific reason.**

**Reasons have to be produced — `admitId` returns bare `null` for every failure.** A classifier is
needed, and **this is where D2's inversion pays a second time**: R2 replaces an allowlist with
*named rules*, so each refusal has a natural reason string (`escape-sequence`, `control-char`,
`invisible`, `traversal`, `backslash`, `too-long`, `leading-separator`, `uw-namespace`), where an
allowlist could only ever say "did not match". **R2 must land first**, and it does — Ship A.

**Revision 2 called the detail view "the one place in the product that renders a hostile string".
That was wrong, and the older egress is already open** *(G1, now #52)*. `menu/denylist.mjs:132`
pushes `String(raw)` and `:140-143` joins it into a `console.warn`; captured stderr shows raw
`U+001B` and raw `U+202E` both surviving to the terminal **today**, outside any frame, during an
ordinary `--dry`. The function's own comment says this is latent *"but it goes live with Task B6"* —
and R8/R10/R14 **are** B6. So the detail view is the *second* such place, and the first is older and
unguarded.

**One representation, decided at the producer** — adopting the architect's synthesis rather than my
"sanitise twice":

```
{ id: <sanitised>, reason: <code>, removed: <count of code points stripped> }
```

R17 defines it, and **the warn site, the snapshot ingest, and the overlay all consume the same
shape**. That closes the stderr egress at its source and replaces an instruction to sanitise at each
of N call sites — which is only as good as the enumeration — with a single form that is safe by
construction. It is checkable by reading a type instead of auditing callers, and it does not silently
acquire a new hole when someone adds the N+1th consumer.

**`removed` is not decoration.** A sanitised id can read as entirely legitimate: `foo\x1b[2Jbar`
renders as `foobar`, so the reason code names the class of problem while the rendered string shows no
trace that anything was taken out. One integer corroborates the reason, and it draws no attack.

**"The id as advertised" therefore means the sanitised form plus that count, deliberately.** Rendering
raw bytes would draw the attack; a stripped id, the reason `invisible`, and `removed: 1` together tell
the user strictly more than a reversed-looking string does.

**Staleness budget: passes with nothing new.** `rejected` is computed at snapshot build time from
data already in hand, so it refreshes exactly when the snapshot does — no probe, no cadence, no new
clock. It rides the **same 2 → 3 schema bump as provenance** rather than adding a second migration.

---

## 3. Staging and review checkpoints

**"Independently shippable" overstated it for Ship D, and the honest framing is review checkpoints
inside one landing.** R11's intermediate state — routing widened ~43×, declarations frozen at 83 —
*maximises* the undeclared population §1.2 prices as the cost, and is never intended to reach a user.
The attribution discipline behind the split is right (unattributable deltas are how #22 hid through
412 green tests); the claim that each stage is a shippable state was not. Ships A, B, C and E are
genuinely independent; **D is one landing with three internal checkpoints.**

| Ship | Contents | Independent? | Checkpoint |
|---|---|---|---|
| **0 — the #53 guard fix** | **R0 alone** | **yes, and independently revertible** | **security review; lands before everything** |
|---|---|---|---|
| **A — additive** | R1 R2 R3 R4 R5 | yes; nothing changes what routes | ordinary review |
| **B — the guard** | R6 R7 | yes; two edits to one function | **security review** |
| **C — discovery** | R8 R9 R10 | yes; cache-only, wired to nothing | **security review** + live-run authorization |
| **D — widen routing (D4 step 1)** | R11 R12 R13, then **R13b** behind an internal gate | **no — one landing**, R11's intermediate state must not ship | **review + live-apply authorization**, and R13b reviewed separately |
| **E — uwpick (D7) + refusal disclosure (#51)** | R17 R14 R15 R16 R18, in that order | yes; display and interaction only | ordinary review, **plus a security look at R18's hostile-string rendering** |

**Hard ordering constraints** *(revised — F4; Ship 0 added in revision 3)*:

- **Ship 0 lands first, alone, and before every other ship.** #53 is a live vulnerability on `main`,
  not a plan defect: the plan is at iteration 3 of a maximum 5 with no implementation started, and
  the hole stays open for all of it. R0 is the first writer of `keysync/run.mjs`, so **R6 and R7 are
  serial after it**.

- **R4 (V9) before R7.** Under A2 the guard's verdict tracks CCR's resolution exactly, and that holds
  only while nothing but keysync mutates `Providers[].models`. `autoFetchModels: true` breaks it
  (#44). V9 is a **dependency of the guard's correctness**, not tidying, and it already sits in
  Ship A ahead of Ship B.
- **R5 before D.** The join is D's capability source.
- **C before D.** D has no discovered set without R10's cache. *(Restored — revision 2 dropped this
  line while rewriting the B-before-C item, leaving the dependency asserted in prose only, M10.)*
- **B before D**, not B before C. Revision 1 said B before C on the grounds that the vouch had to
  exist before discovery could make the guard fatal; with the vouch gone, nothing reads the discovery
  cache until R11 in Ship D. **B and C are file-disjoint and may run as parallel lanes** — B writes
  `keysync/run.mjs` + `test/denylist.test.mjs`, C writes `refresh/**` + `test/discover.test.mjs`.
- **R6 and R7 are strictly serial and both edit `checkBareCollisions`.** They must not be landed as
  independent edits: R6 changes *which ids are classified* (the filter at `run.mjs:126`), R7 changes
  *how ownership decides fatal* (the block at `:151-171`). Composed, they move the guard from
  "Claude-shaped, relay-stripped" to "really-Anthropic, CCR-faithful". Landing them out of order or
  in one commit makes the combined test delta unattributable.
- **R13b is gated inside Ship D, not merely ordered.** R11 must have run and printed its measurement,
  and that measurement must have been reviewed, before R13b starts. The gate exists to keep R11's
  review boundary intact: R11 is a routing change that provably alters no declaration, and R13b is a
  declaration change made deliberately against evidence. Collapsing them loses both criteria.
- **R19 before every other Ship D task, and before any live apply.** It repairs the rollback path the
  rest of Ship D leans on; without it the named safety net is broken machinery (A7).
- **#34 before Ship E** *(revision 5 — asserted in B5's prose and missing from this list, a mild echo
  of M10)*. Six structural guards resolve from `$HOME/.uw` rather than `import.meta.url`, and
  `uwpick.test.mjs`'s budget test **returns silently** when that tree is absent — so R16's and R18's
  frame-width observables can pass by not running. Fixing #34, or proving non-vacuity per B5, gates
  Ship E.
- **E after D by data, not by file.**

**D4 step 2 is not in any ship.** Its cost is §1.2; it needs its own scoping.

---

## 4. Ordered tasks

Every task names the files it **WRITES**, so parallel-safety is checkable by inspection. Lanes are
split by file, never by directory. Two tasks that write the same file are serial even where their
subjects are unrelated.

### Ship 0 — the #53 guard fix, alone

---

**R0 — `checkBareCollisions` models `resolve()`'s two-stage match (#53).**

**WRITES:** `keysync/run.mjs`, `test/denylist.test.mjs`.
**Serial before:** R6, R7 — every other writer of `keysync/run.mjs`.
**Depends on:** nothing. Lands first, on its own, independently revertible.

**Exactly one change. Nothing else ships in this task.**

Stop keying `byBare` on the advertised string. Build a **candidate selector set** — the strings Claude
Code can actually send — and for each selector compute ownership the way `resolve()` does:

1. the **exact** owner set;
2. **if and only if that is empty**, the **case-insensitive** owner set.

**Both stages, in order.** Case-sensitive alone is today's bug. Case-insensitive alone reports a false
safe when two resellers advertise `Opus` and `opus` with no relay, because CCR's B4 finds exactly one
*exact* match for `opus` and binds it.

**And `.trim()` on both sides of every comparison** *(A1 — found independently by both reviewers)*.
`providerModelMatches` does `let a = s.trim()` before comparing, and `Qe()` trims the selector.
Revision 3's R0 modelled `resolve()`'s case folding and stopped short of its trimming, which is the
**third instance of the #22/#53 shape**: a guard faithful to most of a matcher.

**The hazard is created by Ship A, not by Ship 0, which is why no single-task review finds it**
*(measured)*. `CTRL` is `[\x00-\x1f\x7f-\x9f]` and **space is `0x20` — outside it**. Today
`admitId(" opus")` returns `null` because the allowlist anchors on an alphanumeric; under R2's
inverted denylist `" opus"` is **admitted**. So once Ship A lands, a reseller can advertise `" opus"`,
CCR trims and binds, and an untrimmed R0 reports nothing. Neither ship opens it alone.

*(Tab is covered — `\t` is `0x09`, inside `CTRL`. It is the space character specifically that slips
through, which is exactly the kind of boundary a denylist has to be checked against rather than
reasoned about.)*

**Explicitly NOT in Ship 0**, each separable and each carrying its own argument: D1's null-fallback
change (`realIds ?? ANTHROPIC_FULL`) stays in **R6** — it changes *which ids are classified*, where
this changes *how ownership is computed*; A2's fatal-from-unstripped-owners and H5's dead-branch
cleanup stay in **R7**; everything in Ships A and C–E is untouched.

#### The question that decided this is answerable, and I measured it

The team lead asked to be told if two-stage modelling turns out to be inexpressible without D1's set.
**It is expressible**, because the classification set is finite on *both* branches — which I confirmed
rather than assumed *(measured this session)*:

| advertised by a lone reseller | `realIds` **null** (today's fallback) | `realIds` a **Set** (production, `run.mjs:762`) |
|---|---|---|
| `opus` | `fatal: true` | `fatal: true` |
| `Opus` | **`fatal: true`** | **`fatal: false`** |
| `OPUS` | **`fatal: true`** | **`fatal: false`** |
| `Claude-Opus-5` | **`fatal: true`** | **`fatal: false`** |

**#53 is a defect of the narrowing specifically, not of the guard generally.** On the null path every
RESERVED-shaped advertised id becomes its own key, so case variants are already caught; the
production path drops them because `ANTHROPIC_ALIASES.includes(id)` and `realIds.has(id)` are
strict-equality. So the selector set is:

- `realIds !== null` → `ANTHROPIC_ALIASES ∪ realIds` — given, finite;
- `realIds === null` → the advertised RESERVED-shaped ids, **as today apart from the trim** — derived
  from the config, also finite.

**"Exactly as today" and "R0 keeps today's null branch untouched" were both false, and this is the
correction** *(F1/B2 — falsified independently by both reviewers and measured twice at
implementation)*. `.trim()` runs **before** the anchored `RESERVED` gate, so it changes **which ids
are admitted**, not only how an admitted id matches. `RESERVED.test(" opus")` is false and
`RESERVED.test("claude-opus-5 ")` is true, so on the **null branch**:

| advertised | before R0 | after R0 |
|---|---|---|
| `A:" opus"` | no key at all | `opus → [A]` |
| `A:"claude-opus-5 "` + `B:"claude-opus-5"` | `fatal: true`, 2 hijackable | `fatal: false`, one `shadowed` |

The same merge happens on the `realIds` branch (`fatal: true` → `shadowed`). **The new direction is
the faithful one** — CCR compares trimmed forms — so it stands; what was wrong was the plan's claim
that the branch was untouched. Not live today, since `admitId(" opus")` returns `null`; it goes live
with **R2**.

R6 later swaps only this branch's **selector source** to `ANTHROPIC_FULL`, leaving the trim in place.
The two changes compose without either needing the other, which is what makes this split real rather
than bookkeeping.

#### Test delta — zero inversions, additions only

*(§6.0's rule applies here too: the claim is an enumeration, not "413 stays green".)*

**No existing guard test inverts, and that is a measured claim, not an expectation.** *(Citation
corrected — L17: there are **35** `checkBareCollisions` call sites, not 45, and the `P(...)`-form grep
revision 3 cited covers only some of them, since most guard tests build object literals. The
conclusion survives on the broader scan — no guard test in `test/denylist.test.mjs` uses an uppercase
model id in any form — but the narrower grep was not proof of it, and citing it as proof was the
error.)* Absent a case variant the
restructuring is **verdict-identical**: an id in the classification set advertised by exactly one
provider yields size 1 under both formulations; an id in the set advertised by nobody yields an empty
exact set, an empty fold set, and no finding, where today it simply never becomes a key.

**Eight** tests are added — the three below, plus five for the B1 entry-counting fix *(count
corrected twice: "two" predates both observable (3) and B1; "seven" predates the relay-strip
fixture)*. The B1 five are enumerated with the fix in the mutation table above: the fold flip
(`Opus` + `OPUS` at one provider), **B1/F3** (a byte-identical duplicate), **B1/L16** (two providers
sharing a name), the **relay-strip** fixture (the relay holding *two* matching entries for one
selector, unvouched), and a control pinning the two verdicts that must **not** move — the sole
reseller on `opus`, and `tabiai:Opus` + `gorouter:opus` naming gorouter. The first three each flip
`fatal: true` → `shadowed`, which is the ship's shape change; the strip fixture guards the one
direction the guard must never fail in (**under**-report); the control is what stops entry-counting
from becoming a blanket exemption.

The three `#53` observables:

- **(1) the failing-today observable** — relay absent, a lone reseller advertising `Opus`, `realIds`
  supplied the way `run.mjs:762` supplies it → `fatal: true`. Same for `OPUS` and `Claude-Opus-5`.
  **Confirm it fails against `main` before the fix and passes after**; the baseline above is what it
  must move.
- **(2) the reverse case, which stops the fix being half-made** — `tabiai` advertises `Opus`,
  `gorouter` advertises `opus`, relay absent → `fatal: true` naming **gorouter**, because B4 binds the
  exact match. A case-insensitive-only implementation reports a safe ambiguity here and passes
  observable (1).
- **(3) the whitespace case (A1)** — relay absent, a lone reseller advertising `" opus"`, production
  `realIds` → `fatal: true`. This one **cannot fail on `main`**, because `admitId` still rejects the
  id there; it becomes reachable only once R2 inverts the allowlist. Assert it in Ship 0 anyway —
  Ship 0 is where the guard is made faithful to `resolve()`, and a test that goes live when a later
  ship lands is the only kind that can catch a two-ship hazard.

**Re-derived after the B1 fix, and every row below was run** *(measured at implementation; the table
this replaces was written before entry-counting existed and had two rows that were one program)*:

| mutation | fails |
|---|---|
| drop the case-insensitive stage | (1), and B1's fold flip |
| drop the **exact** stage — **identical to** running the fold **before** it | (2), and B1's control |
| dedupe ids within a provider (`ids` back to a `Set`) | B1/F3 |
| collapse owners to unique **names** (the pre-B1 accumulator) | all three B1 flips |
| drop `.trim()` on the **advertised** side | (3) |
| drop `.trim()` on the **selector** side | **nothing** — see the residual below |
| strip only the **first** relay entry instead of all of them | the relay-strip fixture |

**Two rows collapsed into one, and the earlier attempt to separate them was itself wrong** *(B3)*.
`exact` is always a **subset** of the fold — `id === sel` implies
`id.toLowerCase() === sel.toLowerCase()` — so fold-empty implies exact-empty, and the fold-first
mutant `fold.length ? fold : exact` **reduces to plain `fold`**. Drop-exact and fold-first are
textually different and semantically the same program; no fixture can distinguish them, and the
`tabiai:opus` + `gorouter:OPUS` fixture revision 4 proposed for the job is the mirror of the shipped
one and distinguishes nothing. **Confirmed by running both forms: each kills the same two tests.**

Because the fold contains the exact set, the two stages can **never name disjoint owners**. What the
ordering buys is a **count**, and through it a verdict — which is what the shipped fixture asserts.

#### Residual — where two-stage over-reports, stated rather than discovered later

A guard that fails safe is fine; one that fails safe without saying so becomes the next #9.

- **Selectors Claude Code may never send.** The `realIds` branch treats every published Anthropic id
  as a possible bare selector, including dated ids CC probably only sends namespaced. **Pre-existing
  — R0 does not widen it**, and it fails safe.
- **The null branch reports the advertised spelling, not the sent one.** With only `Opus` advertised,
  the selector set is `{Opus}`, so the finding names `Opus` even though CC would send `opus`. The
  provider named is correct and the verdict is correct; only the id in the message is the reseller's
  spelling. Message accuracy, not a wrong verdict.
- ~~**One known configuration where R0 reports fatal and CCR would not bind**~~ *(L16)*. **RETIRED —
  it no longer reproduces.** Two vault providers sharing a name collapsed into one owner key, so the
  guard read a sole owner where CCR, matching per provider entry, finds two and returns `undefined`.
  The **B1 fix removes the collapse**: ownership now counts matching **entries**, so two providers
  named `tabiai` are two entries and classify as `shadowed`. Asserted by
  *B1/L16: two providers SHARING a name are two matches, not one owner*. **Retired here rather than
  left to be discovered**, because a documented residual that no longer reproduces is worse than the
  bug — the next reader trusts the plan over the code. (`assertRelayNameUnclaimed`'s own gap, the
  same root, is untouched and stays with B1/#25.)
- ~~**A byte-identical duplicate id at one provider reads as a sole owner**~~ *(F3)*. **RETIRED, same
  cause and same fix.** `models: ["opus", "opus"]` is two entries in the array CCR iterates, so it
  pushes twice and binds nothing; entry-counting now agrees. Asserted by *B1/F3*.
- **`hijackable[].id` AND `shadowed[].id` are the SELECTOR, not the operator's spelling**
  *(F2 — new, introduced by R0)*. A reseller advertising `Claude-Opus-5` is told
  `claude-opus-5  <-  sole owner: tokenrouter`, and the operator greps their config for a string that
  is not in it. **The verdict and the provider are correct; only the id shown is not the one they
  typed.** Message accuracy, not a wrong verdict.

  **Both branches, and the `shadowed` one is where R0 *increased* the exposure** — the B1 entry-count
  fix deliberately moves cases *out of* `hijackable` and *into* `shadowed` (a provider listing `Opus`
  and `OPUS` is now reported as `opus (tokenrouter)`, naming neither spelling the operator wrote), so
  the branch this residual originally omitted is the one that grew. Precisely on what did and did not
  change: **the `shadowed` WORDING changed** in this ship, "more than one owner" → "more than one
  match", because entry-counting lets one provider hold several; **the id RENDERING did not**, and is
  deliberately left alone. *(This supersedes the "null branch reports the advertised spelling" bullet
  above for the `realIds` branch, where the direction is now the opposite one.)*
- **A vouched relay sole-owning an id it lists twice now self-notes** *(new, behaviour recorded not
  changed)*. Two entries make `effective.length === 2`, so it lands in `shadowed` as
  `opus (anthropic)` where before it produced no finding at all. **Unreachable in the generated
  config** — the relay's `models` is a `Set` spread unioned with a disjoint array, so it cannot list
  the same id twice — and if it ever did fire it would be reporting something true. Recorded so the
  next reader does not mistake it for a defect; **no code change**.
- **The selector-side `.trim()` is defensive and unverified** *(new)*. No **production-shaped**
  fixture can kill it: neither `ANTHROPIC_ALIASES` nor a `realIds` built at the call site (live
  `/v1/models` ∪ `ANTHROPIC_FULL`) can carry whitespace, so it guards only an Anthropic API response
  returning a padded id. A hand-built `realIds: new Set([" claude-opus-5 "])` does kill it. Annotated
  as such in `run.mjs` rather than left to read as mutation-checked. **The frozen table's
  "drop `.trim()` on either side → (3)" was wrong**: only the advertised side is load-bearing.

#### Revertible alone

`git revert` of R0 must leave a tree that builds and tests green with no dependency on any later
ship. Nothing in Ships A–E reads anything R0 introduces; R6 and R7 edit the same function afterwards
and are written to apply on top of it, not to require it.

**The revert window closes when R6 lands** *(D)*. R6 replaces the null branch of the very selector set
R0 restructures, so after R6 a revert of R0 alone would leave R6's fallback feeding an ownership
computation that no longer exists. **Before R6: revert R0 alone. After R6: revert both, in reverse
order.** State it in the commit message, because a revert is done under time pressure by someone who
has not read this plan.

**One comment must be corrected in the same edit:** `run.mjs:162` calls the empty-owner case
*"redundant"* and records it as mutation-checked. Under R0 it becomes **the common case** — every
selector in the classification set that nobody advertises lands there. Leaving the word "redundant"
in front of the hot path is the confident-wrong-comment failure this codebase has a standing rule
against.

**Verify:** `node --test "test/denylist.test.mjs"` and the two added observables, each checked against
`main` first so the before/after is recorded rather than assumed.

---

### Ship A

---

**R1 — Confirm the #47 main-agent substitution against a live request.** *(read-only)*

**WRITES:** `plans/open-questions.md` (append one OQ entry).
**Parallel-safe with:** every other task in Ship A.

**Confirmation, not discovery** — §1.2 records CCR's own routing documentation naming the built-in
Claude Code route as the substituting layer for **main** requests when the client has not selected a
*recognized* model. Documentation is not a measurement, and pre-mortem scenario 3 rests on this, so
it gets one live check.

Method: make one request against a deliberately unroutable selection and read the answering provider
back out of CCR's request logs via `why.mjs`, which already recovers the real provider identity from
the nested `attempts[]` that Claude Code truncates to "400 All target providers failed".

**Scope fences, both from decisions doc §9:** this is the **main agent** only — do not touch policy
2, `builtInClaudeCodeSubagent`, or per-agent-type routing (§9.2), and do not follow #47's open
question 2 into `hud-shim.mjs` context reporting (§9.1) or question 3 into reopening D9 (#48). Issue
#47's title says "Subagent requests"; that is the misdiagnosis the user corrected, and the executor
must read past it.

**Verify:** one `request_logs` row showing the model *selected* against the model that *answered*.
Expected observable: the two differ, `target_provider_names` is **empty** (resolution failure, not
provider rejection — #47 establishes that as the distinguishing field), and the substituted model is
the Agent Config model. If `target_provider_names` is populated instead, the documented mechanism did
not fire and the finding is different from the one assumed here — say so rather than fitting it.

---

**R2 — D2: `MODEL_ID_OK` inverts from allowlist to denylist.**

**WRITES:** `menu/sanitize.mjs`, `test/sanitize.test.mjs`.
**Parallel-safe with:** R1, R8. (Not with R3/R4/R5 — those write `keysync/keysync.mjs`, which imports
this module transitively; no write collision, but keep the review units separate.)

Replace the anchored allowlist with a denial set. **The denied set is wider than revision 1 proposed,
and the measurement is why** *(H4; measured across 7,730 bundle ids and 2,136 live ids)*:

| candidate denial | real ids costing | verdict |
|---|--:|---|
| `ESC_SEQ`, `CTRL`, `INVISIBLE`, `\`, `..`, length > 128 | 0 | deny (D2 as written) |
| **leading `-`** | **0** | **deny — carried forward** |
| **leading `/`** | **0** | **deny — carried forward** |
| **`@` not followed by alphanumeric** | **0** | **deny — carried forward** |
| **any whitespace, anywhere** | **0** | **deny — A1, and it is load-bearing** |
| leading `~` | 13 | admit (D2's point) |
| bracketed, e.g. `kimi-k3[1M]` | 1 | admit (D2's point) |

Revision 1 dropped the leading-separator anchors as part of "invert to a denylist". **Keeping them
costs zero real ids and closes the argv question without having to characterise Claude Code's
argument parser** — a characterisation the plan would otherwise be silently assuming. D2's pillar
benefit is untouched: a *novel* character still needs no source edit, which is the property
[[key-lifecycle-must-scale]] asks for. Reuse the existing regexes; do not re-type them. `/` stays
legal mid-id (`groq/openai/gpt-oss-20b`). Keep `admitId`'s contract (reject, never sanitise).

**Whitespace is not covered by any existing regex and must be added explicitly** *(A1, measured)*.
`CTRL` is `[\x00-\x1f\x7f-\x9f]`; space is `0x20`, outside it. `admitId(" opus")` returns `null`
today only because the *allowlist* anchors on an alphanumeric — so inverting to a denylist **removes
that protection silently** unless whitespace is denied by name. Zero real ids carry whitespace, and
Ship 0's observable (3) is the test that goes live the moment this task lands. This is the one row in
the table whose omission is a security regression rather than a reach cost.

*(Correction carried from review: `CLAUDE` resolves to `~/.local/bin/claude.exe`, a real executable
spawned `shell: false` — there is no `.cmd` shim, so the shell-metacharacter half of the original
concern does not arise. The leading-separator denials are justified on the argv question alone.)*

**Test delta:** one test loses its subject — `MODEL_ID_OK is anchored at both ends` — because the
regex is gone. Revision 1 implied eight assertions would flip; with the anchors carried forward, the
seven that tested leading-separator rejection keep passing unchanged.

**Verify:** `node --test "test/sanitize.test.mjs"`. Expected observables, asserted individually:
`~anthropic/claude-opus-latest` and `teamorouter/kimi-k3[1M]` are returned unchanged; each of
`"a\x1b[2Jb"`, `"a\\b"`, `"a..b"`, `"a‮b"`, `"a\x00b"`, `"-lead"`, `"/lead"`, `"@-x"`, and a
129-code-point id returns `null`. Plus a one-off count over the live listing corpus showing the
previously-rejected real ids now admit. **The criterion counts distinct id strings: 14.** *(Unit named
— D. The decisions doc states both: **14 distinct ids**, **40 distinct (provider, id) pairs**, because
`~z-ai/glm-latest` is served by kilo, openrouter and nousresearch. Revision 3 carried "40" here and
"14" at §2.5, so an acceptance check written against either would have failed the other. This
criterion is per-string — it verifies the regex stopped refusing these strings — so 14 is the number
it counts, with 40 recorded as corroboration.)*

---

**R3 — `inferTier` reads the live pricing path (#10).**

**WRITES:** `keysync/keysync.mjs`, `test/denylist.test.mjs`, `test/infertier.test.mjs` (new).
**Serial after:** R5 (see the cycle finding below). **Serial before:** R4, R11.

Point `inferTier` at `pricing.offers[].per1MTokens.{input,output}`, **matched to the provider in
hand**, including `priceOf`'s rule that a non-matching offer yields `null` rather than falling back
to `offers[0]` — an `offers[]` array can hold up to 16 entries, most pricing the model at a
*different* host, so folding them answers "is this free anywhere" rather than "is it free on my key".

**This needs a signature change, and revision 1 hid it** *(M8)*. `normalizeModel(id, entry)` calls
`inferTier(entry)` with **no provider parameter**, so a provider-matched `inferTier` cannot be fed
from its current call site. `normalizeModel` therefore takes the provider name and passes it through.

**A cycle blocks the obvious fix, and I confirmed it rather than assuming it** *(read)*. M8's natural
remedy is "call `priceOf`" — but `menu/catalog.mjs:25` **statically imports** `keysync/keysync.mjs`
(deliberately, with a comment explaining why it is not dynamic), so `keysync.mjs` importing
`priceOf` from `menu/catalog.mjs` closes a **circular import**. ESM tolerates cycles, but the
const-binding TDZ hazard is real and it would also drag `ccr-client.mjs`, `atomic.mjs` and their
transitive graph into keysync's. **Resolution: `priceOf` moves into `keysync/catalog-join.mjs`**
(R5's new module, which already owns bundle-entry reading) and both sides import it from there. That
is why R3 now comes after R5, and it is consistent with this plan's own rule that a helper two lanes
need is landed once, first, by the orchestrator.

#### R3 reselects the picker's membership, and revision 3's observable could not see it (A3)

Today `inferTier` returns `"unknown"` for all 4,298 entries, so the sort's first term evaluates
`1 - 1 = 0` for every pair and selection collapses to **shortest-id-first**. Repairing it **turns that
term on for the first time**, which changes *which rows ship*, not just how they are labelled.

**Measured across the bundle this session:**

```
providers with >3 catalogue entries : 118
providers whose top-3 CHANGES       : 21  (18%)

aihubmix  today: hy3-preview | zai-glm-5.1 | coding-glm-5.1
          after: coding-glm-5.1-free | xiaomi-mimo-v2.5-free | coding-minimax-m2.7-free   <- intended
cohere    today: command | command-a | command-r
          after: rerank-v3.5 | north-mini-code-1-0 | rerank-english-v2.0                  <- REGRESSION
```

**For cohere the repair replaces three real chat models with two rerankers**, because rerank is free,
free-first is the primary term, and nothing filters on chat. That is today's `google: lyria | veo-2`
embarrassment arriving by a new route — the defect report 20 §7 already names, re-created by its own
fix.

#### An absent price reads as free, and R3 is what turns it on (#55)

A second defect inside R3's own repair, and **larger than the one that surfaced it**. The bundle
encodes "not priced per token" as `{input: 0, output: 0}` under a **token** `sourceUnit` — identical
in shape to a genuine free tier:

```
google/lyria-3-pro-preview   every offer = {input:0, output:0}        -> reads FREE
google/gemma-3               {input:0.15, output:0.3}                  -> paid
openai/gpt-5-5               kenari 0/0 + frogbot 2.5/15 + neon 5/30   -> genuine free tier
```

*(Measured this session: **4,078** entries carry an offers array — reproduces exactly — and **140**
have a zero offer alongside a non-zero one — also exact. I count **410** whose offers are *all* zero,
under both a strict `per1MTokens`-finite definition and a loose one; the batch cited 691. I could not
reproduce 691 by either method. **The design is unchanged at either figure** — hundreds of entries
classify free on absent data — but the number in the plan is the one I can re-derive.)*

**`gpt-5-5` is what makes the distinction safe: *some* offer zero is a real free tier; *every* offer
zero is a missing price.**

**Rule: where a tier is derived from `pricing.offers[].per1MTokens`, an entry whose offers are all
zero is `"unknown"`, not `"free"`.** `priceOf` needs no change — it reports the bundle faithfully, and
the interpretation belongs at the caller. Under-classifying is the safe direction: an unknown-tier row
sorts after genuine free rows and ahead of nothing.

**This ships with the `inferTier` repair, not after it.** Shipping the repair alone trades one bad
ranking for another. It is also why the two defects compound precisely at google:
`lyria-3-pro-preview` is *both* misread as text *and* misread as free, which is how it survives a
guard written to demote it.

**So R3 is three changes, not one:**

1. **`outputKind` becomes a sort term ahead of free-first** on the routing path, so a free
   non-chat model cannot outrank a paid chat model. The data is already in hand — `outputKind(entry)`
   is called a few lines away in `normalizeModel`.
2. **All-zero offers classify `unknown`, not `free`** (#55, above).
3. **The observable becomes a membership diff plus the boolean gate**, not a label histogram (below).

**Verify — at the call site, not over the bundle** *(M8)*, and **on membership, not labels** *(A3)*.
A bundle-wide histogram can improve exactly as promised while `tier` stays `"unknown"` for most rows
`buildProviders` emits, because the bundle-wide read is unmatched and the call site is matched — and
a label histogram is satisfied by relabelling alone while the top-3 silently moves under it. So:

- **Primary observable — a boolean gate, and revision 4's could not fail.** *"No provider's top-3
  acquires a row whose `outputKind` is `nontext`"* is **monotone**: sorting nontext last means a top-3
  can only shed such rows, never gain them (measured: 0 gain, 25 lose). It was also self-referential —
  written in terms of the function whose blind spot decides the answer. **Replaced by:**

  > **No provider's top-3 acquires a row whose `modalities.output` contains any modality other than
  > `"text"`.**

  Verified against the real bundle *(measured this session)*: **fires on google only** —
  `lyria-3-pro-preview` and `lyria-3-clip-preview` — with **zero false positives**. It works because
  it never decides what a model *is*; it asks only whether R3 made a provider worse, which the schema
  can answer. **`acquires`, not `contains`**: providers whose entire catalogue is generators
  (aws-polly, elevenlabs, voyage, fal-ai, and the `auto` routers) have a top-3 that cannot avoid them,
  and that is not R3's doing. *(I count 33 such providers ignored; the team lead counted 25 — a
  definitional difference in "pre-existing", not in what the gate fires on.)*

- **The failure it exists to catch, which revision 4's criterion reported as clean:**

  ```
  google today: lyria ["audio"] | veo-2 ["video"] | veo-3 ["video"]
  google after: lyria-3-pro-preview ["audio","text"] | lyria-3-clip-preview ["audio","text"] | gemma-3 ["text"]
  ```

  The `outputKind` guard correctly demotes all three *pure* generators, and free-first promotes two
  music generators straight back in — because they declare `"text"` alongside `"audio"`, so
  `outputKind` reads them as text. **R3 re-creates the exact `google: lyria | veo-2` embarrassment it
  cites as its motivation.**

- **Two named fixtures, with opposite expectations, and both are required.** **cohere** proves the
  free-first term works (chat models must not regress to rerankers); **google** proves it is
  insufficient. A gate carrying only cohere passes green while shipping two music generators — each
  one a `behavesAs` declaration.

- **Paired, not substituted:** the boolean is what CI enforces; the **enumerated before/after diff
  across all 21 changed providers** is what a human reads. Neither replaces the other.

- **R3's guard is PROVISIONAL until R11 spends the listing data** (see below). Between Ship A and
  Ship D the capability data has not arrived, so google carries two Lyria previews and this criterion
  is the only thing that says so.

- **Secondary observable:** over `built.picker` from `node keysync/run.mjs --dry`, count rows whose
  `tier` is not `"unknown"`. Today it is **0 of 83** (`keysync.mjs`'s guard `m.tier !== "unknown"`
  never fires, report 12 §4). Expected after: a majority, with the exact figure recorded. **This is
  corroboration, not the criterion** — it passes on relabelling alone.
- **Secondary:** the bundle-wide histogram, for comparison against report 12's `{paid: 3387,
  unknown: 499, free: 412}` and prior-art's `{paid: 3619, free: 405, unknown: 274}`. Reported, not
  gating.
- Then `node --test "test/*.test.mjs"`.

---

**R4 — V9: `autoFetchModels === false` on every provider entry (#44).**

**WRITES:** `keysync/keysync.mjs` (inside `validate`), `test/denylist.test.mjs`.
**Serial after:** R3. **Serial before:** R11.
*(Revision 2 also listed R5 here, which closed a cycle against R3's `after R5` and R5's
`before R4`. The intended graph is **R5 → R3 → R4 → R11**.)*

One rule in the V1–V6 family. The message must name what it protects: that `admitRemoteModels` and
`checkBareCollisions` only ever see what keysync writes, so auto-fetch is a hijack path around both.

**Verify:** `node --test "test/denylist.test.mjs"`. Expected observable: a built config with one
entry mutated to `autoFetchModels: true` yields **exactly one** problem, and its text names the
provider and the bypass. Mutation check: deleting the rule fails that test and nothing else.

---

**R5 — The catalogue join (D3), as an exported pure function.**

**WRITES:** `keysync/catalog-join.mjs` (new), `keysync/keysync.mjs` (`loadCatalog` only),
`menu/catalog.mjs` (the `priceOf` move only), `test/catalog-join.test.mjs` (new),
`test/catalog.test.mjs` (the `priceOf` import).
**Serial before:** R3, R4, R11, R14. **This is the shared helper every later lane needs — the
orchestrator lands it once, first, and no lane re-writes it.**

It also **relocates `priceOf`** out of `menu/catalog.mjs` into this module, unchanged in behaviour,
so that `keysync.mjs` can use it in R3 without closing the import cycle described there. `menu/
catalog.mjs` re-exports it if that keeps its call sites legible; the point is one owner of the
offer-matching rule, not a particular import path.

`loadCatalog` currently discards everything but the provider grouping (report 12 §1). It gains an
index over the bundle's **`aliases[]`** field (10,184 entries) alongside `byProvider`. The join
itself is a new module implementing D3's ladder in order: exact (bare ∪ `provider/model` ∪
`aliases[]`) → normalisation (`models/`, `:free`/`:batch`, `.`→`-`) → case-insensitive →
vendor-qualified tail → `accounts/…/models/`, leading `~`, `[…]` suffix. **The bare-name guard is
part of the function, not of its caller:** an id with no vendor prefix never joins cross-provider.
Greedier normalisation (date-suffix stripping, `-instruct` stripping) is out of scope and rejected.

**Verify:** a one-off script joining `~/.maestro/model_cache.json` against the bundle **as a
measurement fixture only — never as a runtime source**. Expected observable: ≥75% of the 3,784 live
(provider, model) pairs join (locked figure 80%), and `orcarouter/auto` does **not** join
`morph/auto`. Then `node --test "test/catalog-join.test.mjs"`.

---

### Ship B — security review checkpoint

---

**R6 — D1: the classification set becomes `ANTHROPIC_ALIASES ∪ (realIds ?? ANTHROPIC_FULL)`.**

**WRITES:** `keysync/run.mjs`, `test/denylist.test.mjs`.
**Serial before:** R7, R12, R13.

**Serial after R0**, which is the first writer of `keysync/run.mjs`.

Change the null-fallback at `run.mjs:126` from broad `RESERVED` to the curated set. Nothing else in
the guard changes. **R0 has already restructured ownership around the selector set**, so this task
swaps only what populates that set's null branch — from "the advertised RESERVED-shaped ids" to
`ANTHROPIC_FULL`. The two changes were built to compose in this order.

**Revision 1 said "`realIds` effectively never goes null", and that was self-cancelling** *(M6)*.
`run.mjs:762` sets it to `null` whenever `liveCatalog` is falsy, and `:626` prints
`UNAVAILABLE (relay down and no cache)` on exactly that path. **That path is the reason D1 exists** —
a *network failure* must not silently widen the guard to every Claude-shaped string. Stating it as
near-unreachable undercut the whole rationale.

**`RESERVED` becomes a no-op inside this function, and that is a decision, not a side effect**
*(H3)*. **R0, not R6, is what makes it a no-op on the production branch** — once ownership is computed
by iterating `ANTHROPIC_ALIASES ∪ realIds`, every candidate is already in the classification set and
`RESERVED.test()` cannot reject any of them. R6 then extends that to the null branch by replacing the
broad fallback. **Both tasks are named because the drift detector below has to survive both.** After
D1 the narrowing always runs, and
every id in `ANTHROPIC_ALIASES ∪ ANTHROPIC_FULL` matches `RESERVED` *(verified by inspection: all
eight)*. So `RESERVED.test()` can no longer reject anything the second gate accepts.

**Settled: keep it as a documented fast-path pre-filter, and add the drift detector that makes the
no-op safe.** Removing it would leave `isReserved` with a single consumer and lose the one place the
two definitions are compared; keeping it silently would leave a reader unable to tell a live gate
from a dead one. The new test asserts that **every id in `ANTHROPIC_ALIASES ∪ ANTHROPIC_FULL`
matches `RESERVED`** — so if someone adds an id to `ANTHROPIC_FULL` that `RESERVED` does not match,
the pre-filter drops it before classification and the guard goes silent on a real id. That is
precisely the drift `denylist.test.mjs:375` was written to catch, preserved after its original
subject disappears.

**Verify:** `node --test "test/denylist.test.mjs"`, plus a census over a synthetic widened config
built from the listing corpus. Expected observables: the 23 reseller-invention false-positive fatals
(`claude-opus-4-8-think`, `claude-opus-4.6`, `claude-opus-5-fast`, …) no longer classify; a reseller
sole-owning bare `opus` with the relay down is still `fatal: true`; a reseller sole-owning a real
uncurated Anthropic id is still `fatal: true`; and the drift detector passes over the live constants.

**Every new guard test passes `realIds` as a non-null Set and `relayOwned` as the curated set** —
the production shape. #22 is the standing proof that a test omitting them is not a guard test.

---

**R7 — `fatal` is computed from the unstripped owner set (#9, §8 item 1).**

**WRITES:** `keysync/run.mjs`, `test/denylist.test.mjs`.
**Serial after:** R6 (same function — see §3's ordering note). **Hard dependency: R4's V9 must
already be in place**, because A2's fidelity holds only while nothing but keysync mutates
`Providers[].models`.

*(Revision 2 replaces revision 1's per-id vouch. Gone with it: `keysync/vouch.mjs`, the
`--vouch-bare` flag, the persisted artifact, its validation logic, `test/vouch.test.mjs`, and the
F5 ACL surface. See §1.1 for the measurement.)*

Three changes. **The two-stage ownership fix is no longer here — it shipped in R0** (Ship 0), because
#53 is a live vulnerability and had no reason to wait on the rest of the plan. What remains is A2 and
H5, which occupy the same edit region and **land together**:

1. **`fatal` reads `owners`, not `effective`.**
2. **The routes-but-does-not-curate note moves to the `shadowed` branch**, where it is reachable; and
   `routedNotVouched` plus its remedy branch at `run.mjs:198,204-209` are **deleted**, because under
   A2 they can never fire.
3. **`assertVouchedSetIsNarrower`'s doc comment is corrected** (§1.1a).

**Verify:** `node --test "test/denylist.test.mjs"`. Expected observables:

- (a) `owners = {tabiai}` advertising `opus` → `fatal: true` — the real F1 shape, unchanged.
- (b) `owners = {relay, tabiai}`, id uncurated → `fatal: false`, `shadowed`, **and the shadowed
  message names the relay as a co-owner that routes without curating**. *(Revision 2 asserted this
  against the hijackable message, where it can never appear — H5.)*
- (c) relay **absent**, `owners = {tabiai}` → `fatal: true`.
- (d) `owners = {relay}` → no finding.
- (e) **R0's two observables still pass** — the case-variant fatal and the `Opus`/`opus` ordering
  proof. They are R0's, not R7's, but A2 changes the ownership set `fatal` reads from, so this task
  must show it did not re-open #53. **Regression check, not new coverage.**

Mutation checks: reverting `fatal` to `effective` fails (b); re-introducing `routedNotVouched`'s
branch leaves it unreachable and is caught by a coverage assertion rather than a behavioural one —
state that explicitly rather than pretending a behavioural test exists for dead code.

---

### Ship C — security review + live-run authorization

---

**R8 — `refresh/discover.mjs`: profile-driven listing fetch, six outcomes, wired to nothing.**

**WRITES:** `refresh/discover.mjs` (new), `refresh/cli.mjs` (new), `test/discover.test.mjs` (new).
**Parallel-safe with:** R2, and with R6/R7 (disjoint files) — but keep it behind Ship B for the
ordering reason, not a file reason.

Build `plans/phase6-discovery-design.md` §1 as specified; do not redesign it. Required properties:

- `listing: {url, envelope, idField, method}` with cluster-A defaults, so 41 of 47 need no edit;
  `listing: null` is a **positive assertion** that no endpoint exists and is not the same as an
  absent key.
- Six outcomes: `ok{n}`, `empty`, `unsupported-shape` (**recording the top-level keys observed**),
  `auth`, `no-endpoint`, `error{status}`. `empty` and `unsupported-shape` never share a bucket.
- **Lift `headersFor` from `key-health.mjs:39-46`** — it already splits multi-line `headersTemplate`
  and substitutes `{key}` per line, covering clusters D and E with zero per-provider code. Do not
  reimplement; a first-line-only parser silently 401s on agentrouter.
- Append exactly `/models` — never `/v1`. Every baseUrl is already version-complete.
- Transport rules, non-negotiable: **direct fetch, never through the CCR gateway** (F2);
  `redirect: "manual"`; refuse non-https; refuse a query string on a listing URL; bounded concurrency
  6; per-provider failure budget stopping after 3 consecutive auth failures; a scrubbed environment
  (`CCR_UPSTREAM_PROXY_URL`, `HTTPS_PROXY`, `HTTP_PROXY`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`
  deleted) so the fan-out cannot inherit the gateway's proxy (F6).
- **The projection's KEEP list, enumerated per model** *(E — revision 3 specified only what to drop,
  so a literal implementer keeping `id` alone would have been compliant and would have discarded a
  payload these 44 authenticated calls already pay for)*:

  | kept | source |
  |---|---|
  | `id` | `idField` |
  | `capabilityRaw` | the provider's own capability-shaped field, whatever it is called |
  | `contextLength` | integer, range-checked as `admitCatalogEntry` already does |
  | `modalityHints` | filtered to a known vocabulary, never passed through raw |

  **It stays an allowlist.** This must not become "persist everything except the deny list" — that
  inverts F7/F10 and re-admits exactly the org identifiers, account ids and balances the rule exists
  to exclude. **Name the fields; anything unnamed is dropped.**

  **Field names disagree across providers, so they are data, not code** — the same treatment `idField`
  already gets, and for the same stated reason (the first live probe settles it). Eleven providers
  return capability-shaped fields — `routllm`, `zenmux`, `huggingface`, `veniceai`, `llm7`,
  `pollinations`, `kilo`, `orcarouter`, `sambanova`, `aionlabs`, `commandcode` — covering **19 of 83
  rows (22.9%)**, and that is a **lower bound**: only 20 of 44 row-providers were probed on a
  `/models` path and **every probe was unauthenticated** (119 × 401). `llm7` returns
  `model_type: "chat"` — the chat-versus-image discriminator models.dev lacks entirely.

  **Store here, consume elsewhere, and the boundary is not symmetric:** `outputKind` **may** consume
  the listing's `capability` now — decisions D7 §7.2 sanctions it and it is OQ-3's fix, and R14
  already does it. `reasoning` / `bucketFor` **may not** — D3 §4.4 defers authenticated capability
  listings for that, and nothing here reopens it. Capturing now and consuming later is the point;
  discarding now and re-fetching later is what this avoids, since a successor task would need the
  same 44 authenticated requests.

- **Allowlist projection at ingest** (F7/F10): never persist the raw body, response headers, org/
  account identifiers, balances, or provider error text. Keep the numeric status and a fixed enum.
- **Never build a cache path from a remote id — hash it** (F3c).
- The host allowlist is **pinned in code**, not in `providers.json` (F6 — that file is unsigned and
  user-writable).
- **The cache's owner-only ACL is applied and verified per write, and refused at read** if it is not
  owner-only. `ensureBackupDir`'s create-once, failure-swallowing form is not sufficient here (F5,
  §1.8).

**Creating `refresh/` wakes a dormant contracts guard, and R8's own verify cannot see it** *(A2)*.
`test/contracts.test.mjs:215-218` iterates `["menu", "refresh"]` with `if (!fs.existsSync(d)) continue;`
— dormant purely because `refresh/` does not exist *(read)*. Its needles include `/APPDATA/`, and
**`"LOCALAPPDATA".indexOf("APPDATA") === 5`** *(measured)*. §1.8 puts the cache at
`%LOCALAPPDATA%\uw-keysync\discovery\`, and `BOUNDARY_ALLOW` has no entry for `discover.mjs` or
`cli.mjs`. So R8 ships green under `node --test "test/discover.test.mjs"` and **breaks the full
sweep** — the exact gap between a task-scoped verify and the suite.

Resolve it one of two ways, deliberately: add a `BOUNDARY_ALLOW` entry naming the file with a comment
saying why the boundary is crossed, **or** resolve the cache root without naming the variable in
source. Either is fine; silently tripping it is not.

**WRITES gains `test/contracts.test.mjs`** if the allowlist route is taken.

**Verify (offline, no network):** `node --test "test/discover.test.mjs"`, **and the full
`node --test "test/*.test.mjs"` sweep** — the second is what this finding exists to force. Expected observables, one
fixture per cluster: A `{data:[{id}]}` → `ok{n}`; C `{models:[…]}` → `ok{n}`; F `{result:[…]}` →
`ok{n}`; `{data:[]}` → `empty`; `{"foo":[]}` → `unsupported-shape` **with `["foo"]` recorded**;
`listing: null` → `no-endpoint`; 401 → `auth`. Plus: a two-line `headersTemplate` produces **both**
headers; a `http://` url is refused; a url carrying `?key=` is refused; a 302 is refused rather than
followed.

---

**R9 — `providers.json` `listing` migration, and the two probe unknowns.**

**WRITES:** `~/.llmkeys/providers.json` (**hand-edited by the user**, documented as a paste-in table
— this file is never machine-written), `refresh/discover.mjs` (the curated-exception list),
`test/discover.test.mjs`.
**Serial after:** R8.

Modelled on Task B3's precedent: a documented human migration plus a code-side default plus a test
that fails if the human step was skipped. Entries needing a block: `cloudflare` (absolute URL
override, `result` envelope, `idField: ["name","id"]`), `youcom` (`null`), `githubcopilot` (`null`),
`anthropic` (`null`). The other 43 are untouched.

Resolve `xai` and `commandcode` **as data, one probe each** — `commandcode`'s notes say
`GET /models` while its baseUrl ends `/provider/v1`; `xai` is a plain cluster-A entry inexplicably
absent from the listing corpus.

**Verify:** `node --test "test/discover.test.mjs"`. Expected observable: the vault-loading test fails
if any entry in the curated exception list lacks a `listing` key, and passes once the four blocks are
present.

---

**R10 — First live discovery run. GATED: requires the user's explicit authorization.**

**WRITES:** `%LOCALAPPDATA%\uw-keysync\discovery\*.json`.
**Serial after:** R9. Writes nothing in the repo, nothing in `settings.json`, nothing in
`config.sqlite`, and does not touch the gateway.

Two stages. **Smoke:** `--only` one provider each from clusters A, B, C plus **agentrouter**
(cluster D). **Acceptance:** all 44 eligible.

**Verify:** the per-outcome table is printed with per-provider rows and providers named, never keys.
Expected observables:
- **`unsupported-shape === 0` — non-waivable.** A provider being down is a fact about the world; an
  unparseable shape is our own defect and fails the run.
- Coverage printed as `N of 44 eligible`, never "of 47", with `no-endpoint` excluded from the
  denominator and `testModel`-only / catalogue-only providers counted **separately** rather than
  folded into "covered".
- `tabiai` and `gorouter` produce a real outcome (both returned `200 data: []` in the corpus, so
  `empty` is the expected and correct answer — not a failure).
- Coverage below the floor is waivable with `--accept-coverage-delta`; `unsupported-shape` is not.

---

### Ship D — review + live-apply authorization

Order within the ship: **R19 → R11 → R12 → R13 → R13b.** R19 is first because it repairs the recovery
path the other four rely on. Ordering binds, not numbering.

---

**R19 — Settings-backup integrity: make the rollback path real before anything applies (#46, #28, #7).**

**WRITES:** `keysync/safety.mjs`, `keysync/run.mjs`, `test/safety.test.mjs` (new).
**Serial before:** R11, R12, R13, R13b. **Hard gate: no `--target live` apply is authorised until
this lands** *(A7)*.

Ship D adds a live apply and R13b adds a second, **each taking a backup its own run will delete**.
Measured *(this session)*: the only settings backup on disk is
`settings.json.uw-backup-20260905T090726`, from **Sep 5** — the Sep 6 backup was created and removed
by its own run, exactly as **#46** describes (mixed stamp formats make retention delete the newest).
**#28** compounds it: the failure message names a path where no good backup exists, so an operator
following the error is sent to a file that is not there.

Three fixes, one file, one review:

1. **#46** — retention must order by a parseable timestamp, not by string sort over mixed stamp
   formats. The newest backup is never the one deleted.
2. **#28** — `restoreSettings` has two distinct failure modes and the caller reports one; report both,
   and never name a path that was not written.
3. **#7** — assert the security-critical `settings.json` keys survive the rewrite. Report 08 F4 gives
   the exact invariant list; `permissions`, `hooks` and `autoMode` are the ones whose silent loss has
   no visible symptom.

**Verify:** `node --test "test/safety.test.mjs"`. Expected observables: two backups written with
**different stamp formats** leave the newer one on disk after retention (fails on `main`); a forced
`restoreSettings` failure reports which of the two modes occurred and names only a path that exists;
and a rewrite dropping `autoMode` from a fixture is rejected. Then confirm a real `--dry` run leaves a
recoverable backup before Ship D's apply is authorised.

---

**R11 — Decouple routing from picker; retire the cap and `UW_MAX_MODELS` (D4 step 1, D5, #2, #5).**

**WRITES:** `keysync/keysync.mjs`, `test/routing-split.test.mjs` (new), `test/denylist.test.mjs`.
**Serial after:** R4, R5, **R10**. *(Revision 2 omitted R10 while the body claimed routing takes "the
full discovered set" — M10. The discovered set comes from R10's cache, read through the same
`discovery` input R14 defines; state the source rather than implying one.)*

`buildProviders` stops sizing `providers[].models` and `picker` from one array. Routing takes the
full discovered set (admitted, sanitised, joined) from R10's cache, **uncapped**; `picker` keeps a cap
under a **distinct renamed constant** `MAX_PICKER_MODELS_PER_PROVIDER`, **value 3, unchanged**, and
ranked by the **two terms that actually exist** — R3's `outputKind` guard, then the R3-repaired
free-first term, then id length. **No `localeCompare`** (A4, §1.2).

**R11 spends the listing `capability` in the selection sort, and no task did** *(revision 5)*. The
`capability` precedence is implemented by **R14, which writes `menu/catalog.mjs`** — the uwpick
snapshot. R3's defect is in **`keysync/keysync.mjs:buildProviders`**, the sort that selects
`built.picker` *and* `providers[].models`. Two different files, and only the display one was covered.
R11 already **receives the `discovery` input** and explicitly keeps the bundle path for capability, so
the data is in hand and nothing spends it.

Apply the same precedence here: **where a discovered listing supplies `capability`, it outranks the
bundle's `modalities.output` in the selection sort**, exactly as it does in R14's display path. This
is what retires R3's provisional guard — `lyria-3-pro-preview` is `capability: image_gen`/`audio` on
a live listing, where the bundle says `["audio","text"]`. §1.8's store-here-consume-elsewhere boundary
already sanctions it: `outputKind` may consume `capability` now, `reasoning`/`bucketFor` may not.

**R11's byte-identical criterion is measured against post-R3, and that must be stated** *(A3)*. R3
already reselects 21 providers' top-3, so against `main` the criterion fails for R3's reasons and
against post-R3 it passes while R3's reselection was gated by nobody. **The baseline is the build
immediately after R3**, and R3 owns its own membership diff.

**Provenance ranking is deliberately NOT here — it moves to R13b** *(G2)*. Revision 2 put it in R11
while giving R11 no discovery input and no provenance producer, which made the task
self-contradictory: with no data the ranking reorders nothing and the byte-identical criterion passes
**while the feature the task names is absent**; with data it reorders the top 3 the cap selects and
the criterion **must fail**. Neither outcome is a test. Keeping today's ranking makes R11 a pure
routing widening whose byte-identical declaration criterion is genuinely achievable — which is the
review boundary the R13b gate exists to protect — and gives provenance ranking to the one Ship D task
that deliberately changes declarations and has a reason to read the cache.

*(Revision 2, C1/F1: revision 1 said "retire the cap" without qualification. `MAX_MODELS_PER_PROVIDER`
is the sole size control on `built.picker`, so deleting it outright takes the native menu from 83
rows to ~1,584 and the options array past 200 KB. Amended D5 retires it **from routing only**.)*

`UW_MAX_MODELS` and its `NaN` defect (#5) die as originally intended: the successor parses a
validated integer, never a bare `Number()` compared with `>=`.

**And that gets an observable, because revision 3 gave it none** *(A5)*. An executor who renames the
constant and keeps `Number(process.env.UW_MAX_MODELS ?? 3)` passes all four criteria — `NaN` makes
`n >= NaN` permanently false, so the cap silently vanishes and every other assertion still holds.
**Assert that a non-numeric `UW_MAX_MODELS` (e.g. `"x"`) yields the default and a bounded picker**,
not an uncapped one. One assertion, and it is the difference between fixing #5 and renaming it.

The routing set's per-entry capability comes from **R5's join**, `null` on miss → weak bucket.
`behavesAs` remains never-absent on every picker row.

**Verify:** `node keysync/run.mjs --dry`. Expected observables:

- `providers[].models` total ≫ picker row count — the two are now independent, which is the point.
- `validate()` passes. Its picker⊆models tie (`keysync.mjs:724-729`) is a **subset** assertion, which
  widening *relaxes*; confirm it did not need editing.
- **The declaration channel is a strict no-op** *(M5)*. Revision 1's criterion was "unchanged from
  today's 87 (± the relay)" — unfalsifiable: 87 matches neither the real 83 nor the real 94, and an
  11-row tolerance absorbs every value in between. Count is also the wrong property, because 83 of
  the 94 rows carry `behavesAs` and the 11 relay rows deliberately carry none (`keysync.mjs:679`).
  **Assert instead that the set of `{model → behavesAs}` pairs is byte-identical across a `--dry`
  run before and after the change.** That can fail; a count with a tolerance cannot.
- **Print the serialized size of `modelPicker.options`** (today 12,735 bytes over 94 rows), so D4
  step 2 inherits a measurement rather than an argument.
- `node --test "test/*.test.mjs"` — see §6.1 for the named delta; a raw green count is not the
  invariant.

---

**R12 — `--verified-only` stops pruning routing (#6, §8 item 4).**

**WRITES:** `keysync/run.mjs`, `test/verified-only.test.mjs` (new).
**Serial after:** R6, R7, R11.

Remove the `built.providers` filter. Keep the picker filter, the fastest-first `verifiedOrder`, and
the floor guard. Return the count expression at `run.mjs:715-717` to the normal branch.

**The filtering logic is extracted as an exported pure function so it has a runner test** *(L9)*.
Revision 1 promised a `--verified-only` unit test in §6.2 while giving the task only a manual `--dry`
byte comparison and no test file — so the WRITES list was incomplete, and this plan's claim that
WRITES lists make parallel-safety checkable by inspection holds only if they are.

**Verify:** two observables.
- `node --test "test/verified-only.test.mjs"`: given a fixture build and a `verified` set, the
  returned `providers[].models` are identical to the input and only `picker` is filtered.
- `node keysync/run.mjs --dry --verified-only` against the existing `verified-rows.json`:
  per-provider `models[]` counts **byte-identical** to the run without the flag.

---

**R13 — Anchor stability and the bare-ambiguity census at width.**

**WRITES:** `keysync/run.mjs`, `test/routing-split.test.mjs`.
**Serial after:** R12.

`anchorModel`'s last fallback is `built.picker[0].model` (`run.mjs:891`), which silently repoints all
six CCR profile tiers if picker ordering changes. Add an explicit recorded assertion that the anchor
is unchanged across the widening, and re-run the bare-id census at width.

**Scope fence (§9.2).** This is main-agent config integrity, and the change is an *assertion* that
the anchor did not move. It is **not** a licence to edit `ANTHROPIC_TIERS`, reorder
`ANCHOR_PREFERENCE`, or introduce per-agent-type routing. If the assertion fires, the correct
response is to fix the picker ordering that moved the anchor — not to re-pick the anchor.

**Verify:** two observables, both recorded in the task's output:
- `anchorModel` before and after R11 are the same string.
- The census reports Claude-shaped `hijackable === 0` and every ambiguous bare id resolving to
  *unresolved* (fails closed), matching the locked measurement at 667 ambiguous bare ids.

*(Restored — revision 2's R13b insertion stranded this block at the end of R13b, leaving R13 with no
acceptance criteria at all. Its census is pre-mortem Scenario 3's only detection mechanism, so the
loss was not cosmetic: M11/G5.)*

---

**R13b — Size the picker to a measured budget, and state the number's reason.**

**WRITES:** `keysync/keysync.mjs`, `test/routing-split.test.mjs`.
**Serial after:** R13. **Gated on R11's printed measurement**, which must be in hand and reviewed
before this task starts. Last task in Ship D, reviewed separately from R11–R13.

*(Added in revision 2 at the team lead's direction. Revision 2's first draft deferred this to "D4
step 2", which is in no ship — and the undeclared population it governs grows from a handful to
thousands under R11. It needs an owner, a criterion and a place in the ordering, so it has one.)*

Two changes, and they belong together because both decide *which* rows carry a declaration:

1. **Set `MAX_PICKER_MODELS_PER_PROVIDER` from measurement rather than inheritance.** Do not pick a
   number from taste, and do not carry 3 forward silently — either outcome must be stated with its
   reason.
2. **Introduce provenance ranking** — `call-verified` > `listing-verified` > `catalogue-only`, then
   the existing `outputKind` → free-first → id-length terms *(moved here from R11, G2; no
   `localeCompare` — A4)*. This task is
   serial after R10, so the cache exists; it deliberately changes declarations, so a reordering is
   the intent rather than a criterion violation; and it is what makes the ranker mutation in §6.4
   able to fail at all.

**Method.** For candidate caps — at least `{3, 10, 25, 50, uncapped}` — record three quantities
against the real vault:

1. serialized bytes of `modelPicker.options` (today: **12,735 over 94 rows, 135.5 B/row**);
2. `JSON.parse` wall time of the resulting `settings.json` (today: **23,242 bytes** total), since
   Claude Code parses this file at **every launch** and that is the cost being spent;
3. **the undeclared population** — `|routing| − |picker|` — which is the quantity the task exists to
   shrink, and the only one that measures the benefit rather than the cost.

**Acceptance criterion.** The largest cap whose parse time stays within a **stated** ceiling above
today's and whose options array stays within a **stated** byte budget. Both numbers are written into
the code comment beside the constant, with the measurement date — so the next person to touch it
inherits evidence rather than a magic 3. Report (1), (2) and (3) for every candidate, not only the
chosen one; a table nobody can re-derive is not a measurement.

**Four things that must be re-checked because this task moves rows into `options[]`:**

- `assertOptionsComplete` V7 — adding rows is safe for a subset assertion, but confirm rather than
  assume; V7 is the rule that pins the write site.
- `orderNativePickerOptions` — Anthropic must stay first, because `Ato()` iterates in array order and
  that ordering is what keeps a longer menu usable at 10 visible rows with 1-row scrolling.
- **`anchorModel` must be re-asserted**, exactly as in R13. `built.picker[0].model` is its last
  fallback, and a resize that changes ordering silently repoints all six profile tiers. R13's
  assertion proves the anchor survived the widening; it must be re-run here because this task is the
  one that can actually move it.
- `reconcileUserModelPin` — a larger picker can only *preserve* more user pins, never fewer, but the
  direction should be confirmed on a run with a pin set.

**Verify:** the candidate table above, plus `node --test "test/*.test.mjs"`. Expected observables:
`anchorModel` is unchanged; the constant's comment names the budget, the ceiling, and the date they
were measured; and **the undeclared population is reported for every candidate cap**, not only the
chosen one. *(Revision 2 made "the undeclared population falls by the reported amount" the criterion,
which cannot fail when the chosen cap is 3 — the fall is zero and zero is the reported amount, L15.
A per-candidate table is a measurement; a self-satisfying equality is not.)*

**#53 note:** R13b changes which ids sit in `Providers[].models`, so **re-run R13's census after it**.
The bare-ambiguity surface is a property of the built config, and this is the last task in Ship D that
alters it.

---

### Ship E — uwpick (D7), including refusal disclosure (#51)

Order within the ship: **R17 → R14 → R15 → R16 → R18.** R17 keeps its number's distance from R14–R16
because those were reviewed under it; the ordering, not the numbering, is what binds.

---

**R17 — Refusals get reasons: classify, and return them (#51 (c), producer half).**

**WRITES:** `menu/sanitize.mjs`, `menu/denylist.mjs`, `test/sanitize.test.mjs`,
`test/denylist.test.mjs`.
**Serial after:** R2 (the named rules this classifies against) and R7 (which also writes
`test/denylist.test.mjs`). It could land as early as Ship A — its only real dependency is R2 — but it
stays here so #51 reviews as one unit.

Add an exported `classifyRefusal(id)` to `menu/sanitize.mjs` returning `null` for an admitted id or
one of the reason codes named in §2.5. **`admitId` keeps its existing `string | null` contract** so no
current caller changes; the classifier is the discriminator `admitId` never had.

**`admitRemoteModels` returns `rejected` as `[{id, reason, removed}]`** — the single safe
representation of §2.5, with `id` already `sanitizeDisplay`d and `removed` the count of code points
stripped.

**This task closes #52, and that is its first job, ahead of #51.** `menu/denylist.mjs:140-143`
currently joins raw provider strings into a `console.warn`, so an id refused *for carrying* an escape
or U+202E writes it straight to the terminal on every `--dry`. Once the producer only ever emits the
sanitised shape, the warn site cannot regress — it has nothing raw to reach for. **The raw string must
not survive as a second field**, or the egress simply moves.

**Verify:** `node --test "test/sanitize.test.mjs" && node --test "test/denylist.test.mjs"`. Expected
observables:

- one test per reason code, each asserting the **code**, not merely that the id was refused;
- `uw/fast` from a non-relay provider yields `uw-namespace`; from the relay, no refusal at all;
- an admitted id yields `null`;
- **#52:** an id containing `\x1b[2J` and one containing U+202E each produce a `rejected` entry whose
  `id` contains **neither**, with `removed > 0` — asserted on the returned value, so the guarantee
  holds for every consumer rather than for the one that happens to be tested;
- **captured stderr from `admitRemoteModels` with `warn: true` contains no `\x1b` and no U+202E.**
  This is the observable that fails on `main` today.

Mutation checks: collapsing any two reason codes fails exactly that pair's tests; keeping the raw id
on the returned object fails the stderr observable.

**The boundary of the completeness claim, stated because the claim is what makes it dangerous**
*(B2, #24)*. R17's argument is explicitly that one representation is *"safe by construction… does not
silently acquire a new hole when someone adds the N+1th consumer."* That is true **for
`admitRemoteModels`, and it does not reach the relay.** `keysync/anthropic-catalog.mjs` feeds relay
ids into `deriveAnthropicSets` → `Providers[].models` **without calling `admitId` or
`admitRemoteModels` at all** (#24), and it is in no WRITES list here.

The risk is not that R17 makes #24 worse — it does not. It is that a completeness framing makes the
*second* path harder to notice afterwards than it is today. **Two options, and this plan takes the
second:** extend the representation to the relay path (a real change to a file this plan does not
otherwise touch), or **state the boundary in R17's own comment** — "this guarantees the
`admitRemoteModels` path; the relay path is #24 and is not covered here." **Named successor: #24**,
which should be fixed before or with Ship C, since R10's discovery is what makes the relay's id list
grow.

---

**R14 — Give provenance a producer: `discovery` and `provenanceOf` into `buildFrom`; wire the join;
live `capability` overrides `outputKind`; carry `rejected` onto the row.**

**WRITES:** `menu/catalog.mjs`, `test/catalog.test.mjs`.
**Serial after:** R5, R10, R17.

**#51 addition:** `buildFrom` already calls `admitRemoteModels` and destructures `{ kept }`, throwing
`rejected` away at two sites (the catalogue entries and the `testModel` guard) — and under this task a
third, the `discovery` candidates. All three are collected onto the provider row as
`refused: [{id, reason, removed}]` — **the same single representation R17 produces**, carried through
unchanged. `buildFrom` does not re-sanitise and does not reconstruct the shape: there is one safe form
and this consumes it (§2.5, G1/#52).

*(Revision 2, C2. Revision 1 had this task carry provenance without anything computing it — see
§1.5a.)* Two new inputs on `buildFrom`, both defaulted so every existing test keeps working:

- `discovery`, shaped like `catalog` (`{byProvider: Map}`), **defaulted to an empty Map**. Candidates
  become `union(discovery ids, catalogue ids, testModel)` — without this, a model that appears *only*
  in a live listing never becomes a row, which is exactly the `listing-verified` population.
- `provenanceOf(provider, id)`, **defaulted `() => null`**, mirroring `routableOf` /
  `makeRoutableOf` because that is the pattern this codebase already uses for a refresher-resolved
  value injected into a pure builder.

**Verify:** `node --test "test/catalog.test.mjs"`. Expected observables:
- a model present **only** in `discovery` becomes a row, with `provenance: "listing-verified"`;
- a model present only in the bundle becomes a row with `provenance: "catalogue-only"`;
- the vault `testModel` is `"call-verified"` and survives regardless of the listing (D3 §4.1);
- with `discovery` defaulted empty, every row's provenance is `null` and **no row disappears** — the
  proof that the default is inert;
- over a fixture whose live id differs cosmetically from the bundle's, `capsOf` returns real
  tri-state values rather than three `null`s;
- a listing `capability: "embedding"` yields `outputKind: "nontext"` even where the bundle says
  `output: ["text"]` (the `nvidia/bge-m3` shape, OQ-3);
- a bare-name row still joins to nothing;
- **an id refused by `admitRemoteModels` appears in the row's `refused[]` with its reason, and does
  not appear in `models[]`** — the two lists are complementary, which is the property that makes the
  count in §2.5(a) meaningful.

---

**R15 — Snapshot schema 2 → 3: `provenance` per model, `discoveredAsOf` and `refused[]` per
provider.**

**WRITES:** `menu/snapshot.mjs`, `test/snapshot.test.mjs`.
**Serial after:** R14.

`snapshot.mjs:main()` supplies `provenanceOf` and `discoveredAsOf` from the discovery cache, and
prints a degraded-reading line when the cache is absent — the same three-branch announcement `main()`
already makes for routability.

**Copy the injection pattern, not the error handling** *(B4, #27)*. Revision 3 said "exactly as it
already supplies `routableOf` and `routableAsOf`", and that pattern carries an **unguarded `await`**:
a rejection from the cache read propagates out of `main()` and **no snapshot is written at all** —
turning a degraded input into a total build failure, which is the opposite of the three-branch
announcement it sits beside. Wrap the discovery-cache read so a failure yields `null` provenance and a
null stamp with a printed line, never an unwritten snapshot. **#27 is the named successor for
`routableSet`'s own unguarded await**, which this task does not fix.

**`?? null` at the serialization site, and this is not pedantry** *(C2, second-order)*.
`snapshot.mjs:49` coalesces `routableAsOf ?? null`, but the per-model literal at `:54-63` does not —
so `JSON.stringify` **drops an `undefined` key entirely**, making the field *absent* rather than
`null`. The new per-model field must coalesce.

**Verify:** `node --test "test/snapshot.test.mjs"`. Expected observables: a schema-2 file returns
`{ok:false, reason:"schema"}`; `provenance` is present as an **own property** on every serialized
model even when unknown (assert `Object.hasOwn`, not `=== null` — the two differ exactly on this
bug); the key-set test is **updated to require it**, because a test asserting the old key set is
exactly what certified `routable` being dropped on every build (B4/OQ-4); and an observable that
**fails when the cache disagrees with the bundle** — a model in `discovery` but not the bundle must
appear with `listing-verified`, so a silently-ignored cache cannot pass.

**#51 addition:** the per-provider literal gains `refused`, on the **same 2 → 3 bump** — one
migration, not two. It carries the same `?? null` / explicit-array discipline as the rest: an
absent-vs-empty distinction here would make "nothing was refused" indistinguishable from "nobody
looked". Assert `Object.hasOwn(row, "refused")` on every serialized provider.

**A third field rides the same migration: the real modality** *(B3, #43 + #38)*. R14 introduces the
listing's `capability` — which **is** the per-model modality #43 asks for — and revision 3 spent it
only on overriding a three-valued `outputKind`, so the `ctx` cell keeps rendering `"nochat"` for
image, audio, video and embedding alike. #43's recommendation was to amend the criterion *or* widen
the schema, and the schema is **already being bumped 2→3 with two fields**; a third costs one
migration instead of two. Add `modality: <string|null>` per model, sourced from the listing's
`capability` where present. The `ctx` cell may then name it (D2-A's original intent) instead of
collapsing four kinds to one word.

**And #38's stale comment must go.** `menu/pick-state.mjs`'s `initState` claims a dropped pin *"still
renders in the tree, dimmed, with its modality"* — false today, and **R18 opens that exact file**. A
confident wrong comment is the defect by this codebase's own standing rule (`menu/catalog.mjs:112-122`),
and leaving it in a file this plan edits would be choosing not to fix it. **Folded into R18**, whose
WRITES already covers `menu/pick-state.mjs`.

**`discoveredAsOf` needs an observable that can fail, and revision 2 gave it none** *(M13)*. R15
asserted `provenance` via `Object.hasOwn` and never asserted the stamp at all, while R16's observable
passes with a permanently-null stamp — because null renders as a dash, exactly like `routableAsOf`.
That is the original C2 defect one field over: a value the renderer reads and nobody writes. Assert
that **a build with a populated discovery cache writes a non-null `discoveredAsOf`**, and that one
without writes `null` — two cases, so neither a hardcoded null nor a hardcoded timestamp passes. The
template exists at `test/snapshot.test.mjs:171` and `:186`.

---

**R16 — The D7 render: provenance gutter, `W.id` 34 → 37, `discovered` stamp.**

**WRITES:** `menu/style.mjs`, `menu/uwpick.mjs`, `test/style.test.mjs`, `test/menu-layout.test.mjs`,
`test/uwpick.test.mjs`.

**`menu/uwpick.mjs` is on this list and nearly was not.** `frame()` renders `meta`, but `meta` is
*built* at `uwpick.mjs:49-56` — a fixed literal of four fields. Adding a `discovered` stamp to the
header without adding `discoveredAsOf` there ships a header that reads `undefined` on every row,
which is the `routableAsOf` failure (B3/OQ-4) repeated: a field read by the renderer and written by
nobody.

*(`menu/pick-state.mjs` is untouched **by this task**. It is no longer untouched by Ship E — **R18
writes it**; see §8's correction.)*

**This task also lands `padId`** — middle elision with a one-code-point marker, and the
highlight-after-elision fix (§2.3, issue #49). Both live at `style.mjs:373`, so they belong to this
task rather than a follow-up: the truncation and the gutter touch the same expression, and splitting
them would mean editing that line twice.

**Verify:** `node --test "test/style.test.mjs" && node --test "test/menu-layout.test.mjs"`. Expected
observables:
- Every rendered line measures **exactly `FRAME_W` = 78** under `vis()` — the existing invariant,
  re-asserted with the new gutter, a 37-code-point id, an elided id, **and the ASCII glyph set**
  (the case where a reused `g.ell` would have put every row two columns over).
- Each of the four provenance states renders a **distinct glyph** with `caps.colours === 0`, in both
  UNI and ASCII. (This is `healthDot`'s own failure mode: its predecessor returned the same glyph for
  ok, needs-$ and broken, under a test titled as if it checked otherwise.)
- Padding happens **before** colouring — assert the coloured cell and the bare cell have the same
  `vis()`.
- `null` provenance renders blank **and** the header shows the `discovered` stamp, so blank is
  disclosed rather than implied.
- **Elision is measured against the real population, not a fixture:** over the 1,588 snapshot
  targets, **zero pairs within a provider group render as identical strings** (today: 67 rows in 24
  groups; at a naive `W.id` 37: 38 in 15), or the residual is named and justified.
- **No filtered row renders without a visible match indication:** filtering `instruct` (144 rows,
  **39 blind today**) and `thinking` (62 rows, **22 blind today**) yields zero blind rows, with a
  match inside the elided middle signalled by colouring the marker.

**#51 addition — the persistent provider-level indicator (§2.5(a)).** `W.refused = 3` plus a
one-column gap after `health`. The level-0 row **allocates 70 of 75**, so this lands at **74 with 1
spare** (G4/M12 — not the 68-of-75 revision 2 claimed). **Blank when the count is zero.** The header
cell derives from the same `W` constants as the row — `menu-layout`'s derived-offset test asserts
they agree rather than trusting it, which is the test that caught the previous off-by-one.

Extra observables: a provider with zero refusals renders a **blank** cell, not `0`; a provider with
refusals renders the count; and the level-0 frame still measures exactly 78 in both glyph sets.

---

**R18 — The refusal drill-in: reducer state, modal overlay, hostile-string rendering (#51 (b)).**

**WRITES:** `menu/pick-state.mjs`, `menu/style.mjs`, `menu/uwpick.mjs`, `test/pick-state.test.mjs`,
`test/style.test.mjs`, `test/uwpick.test.mjs`.
**Serial after:** R16 (same `style.mjs` and `uwpick.mjs`).

**What the reducer ends up owning — stated explicitly, because decisions doc §9.1 depends on it:**

- **one nullable field**, `state.refusals`: `null` when closed, otherwise
  `{ provider: <keyId>, top: <scroll offset> }`;
- **one control-key binding**, `ctrl+r` / `c0 === 18` *(measured free: the bound codes are 3, 6, 8,
  10, 13, 27, 127)*, **reachable from both levels** — at level 0 for the focused provider, and at
  **level 1 for the provider being viewed**, where `state.provider` is already in hand *(H3 —
  revision 2 restricted it to level 0, which is the wrong half: a user who notices models missing is
  looking at that provider's model list, not at the provider index)*. A no-op wherever the refused
  count is zero, so an empty overlay can never open;
- **one modal rule**, which borrows `legend`'s **placement but not its grammar** *(H1/L14 — revision
  2 said "matching `legend`'s", which is false)*. `legend` swallows **every** key including arrows in
  a single branch at `pick-state.mjs:238`, sitting *above* the arrow handler at `:252`. A scrollable
  overlay is a two-branch rule — arrows scroll, everything else closes — and `legend` establishes no
  such precedent. What is reused is the modal *position* in the dispatch chain, not the swallow-all
  behaviour;
- **a pinned dispatch position**, which is load-bearing: **after the `ctrl+c` check, before both the
  `legend` branch and the esc ladder.** Placed after `legend`, pressing `?` stacks a second modal;
  placed after the esc ladder, esc falls through and clears the filter instead of closing the
  overlay;
- **one projection**, `refusals` into the view object beside `legend`.

That is the whole of it: **one nullable object, one binding, one modal rule, one projection.** No new
level, no change to the esc ladder, no change to filtering.

#### Also in R18: cap the displayed recents at 5

**Stated here rather than left to ride along**, because R18's WRITES list is the parallel-safety
guarantee and a reader should not have to infer that this arrived with it. It is additive to
`menu/pick-state.mjs`, already in that list for the overlay.

Live today *(measured)*: **10 stored recents, 0 favourites** — 9 render after the `known` filter, and
`rowsAvail` is `max(3, termRows - 6)` = **24 on a 30-row terminal**, so the pinned block consumes
**37% of the pane** and pushes providers below the fold. At 5 it consumes 21%.

- **Cap the display in `initState`, applied *after* the existing
  `known.has(t) && !favourites.includes(t)` filter.** Capping before it lets a recent that is also a
  favourite consume a slot while rendering zero rows.
- **`MAX_RECENTS = 10` is untouched.** The complaint is menu inflation, which is a rendering property;
  changing the storage bound would silently discard history on the next `recordRecent` write — a
  larger change to persisted-state semantics for the same visible effect.
- **Favourites are not capped.** An explicit user action, not an accumulating side effect.
- **A named constant adjacent to `MAX_RECENTS`, with a comment saying which is which.** At 5 displayed
  against 10 stored, **the display cap is now the only bound on the pinned block** — storage is 2× it
  and can never be what limits rendering. A reader at `MAX_RECENTS = 10` would otherwise have no way
  to discover that ten is not what renders.
- **`#38`'s false comment at `pick-state.mjs:96` is removed in the same edit** — it sits four lines
  above the `pinned` construction this task modifies, and B3 already schedules its deletion.

**Ordering is safe by construction, not by discipline** *(measured)*: `recordRecent` builds
`[target, ...s.recents.filter(...)]`, so storage is **newest-first** and a slice yields the most
recent. And `initState(rows, { recents, favourites, termRows })` receives recents from stored state,
so #26's ctrl+f rebuild passes the same array and produces the same count — the cap cannot be
influenced by anything the reducer holds.

**Verify:** `initState` with **9 known recents and 0 favourites yields exactly 5** `mark: "~"` entries,
in most-recent-first order; and a favourite that is also a recent appears **once as `"*"` and does not
reduce the recent count below 5**. The second is the ordering trap — a test counting only total pinned
rows passes while the cap silently loses a slot.

**`sanitizeDisplay` at render, as defence in depth — not as the guarantee.** Under §2.5's single
representation the id arriving here is already safe, so this pass exists only because the snapshot is
a file on disk that something else could edit, and a renderer must be safe against any input
regardless of provenance. The distinction matters for review: if this pass is ever the *only* thing
standing between a hostile id and the terminal, R17 has regressed and #52 is open again.

**Verify:** `node --test "test/pick-state.test.mjs" && node --test "test/style.test.mjs" &&
node --test "test/uwpick.test.mjs"`. Expected observables:

- ctrl+r on a provider with refusals opens the overlay for **that** provider; on a provider with none
  it is a no-op; on a model row at level 1 it opens the overlay for **the provider being viewed**
  (see below); nothing opens an empty overlay.
- The overlay lists each refused id **with its reason and its `removed` count**, and closes on any
  non-arrow key.
- **Dispatch-position observables, one per failure mode:** with the overlay open, `?` does **not**
  open the legend; `esc` closes the overlay and does **not** clear the filter; `ctrl+c` still exits.
- **The load-bearing security test:** an id refused *for carrying* `\x1b[2J`, and a second refused for
  carrying **U+202E**, both render with **no escape sequence and no bidi override reaching the
  frame** — asserted against the rendered string, not against the sanitiser. This mirrors the
  existing "escape sequences in a model id cannot reach the frame" test, and it is the one place in
  the product where a hostile string is deliberately displayed.
- Every overlay line measures exactly `FRAME_W` = 78, including a line whose id is at the 128-code-
  point limit.
- **The frame-width observables must be proven non-vacuous** *(B5, #34)*. Six structural guards
  resolve from `$HOME/.uw` rather than `import.meta.url`, and `uwpick.test.mjs`'s budget test
  **returns silently** when that tree is absent. R16 and R18 both write that file, and width
  assertions are exactly the kind that pass by not running. Assert that the test **actually executed**
  — a counter, or a deliberate failure injected once to confirm the suite sees it. **Named successor
  for the root cause: #34**, which this plan does not fix.
- Mutation check: removing the render-time `sanitizeDisplay` fails the escape/U+202E test and nothing
  else.

---

## 5. Pre-mortem — three ways this ships broken

### Scenario 1 — keysync will not run at all

*(Rewritten in revision 2. M9 showed revision 1's named instance cannot fire, and A2 changes the
scenario's shape. Both corrections are below rather than a quiet substitution, because the reason the
instance was wrong is itself worth carrying.)*

**Revision 1 named `claude-opus-4-8` as the first instance. It cannot be** *(M9, closed by the team
lead against the vault)*. `~/.llmkeys/providers.json` gives **both** `tabiai.testModel` and
`gorouter.testModel` as `claude-opus-4-8`; both providers return `200` with `data: []`; and D3 §4.1
keeps `testModel` regardless of the listing. So both still own it after discovery and it stays
`shadowed` at `run.mjs:165`. Under D1's null path it would not even classify, since it is not in
`ANTHROPIC_FULL`. Naming an instance that cannot fire is how a pre-mortem stops being read.

**The story, restated at class level.** Ship C lands and discovery populates the resellers. Some real
published Anthropic id turns out to be **sole-owned** by exactly one non-relay provider — the relay
either absent (down, or `--no-anthropic`) or genuinely not serving that id. `checkBareCollisions`
exits 1 **before any write**, on the main path, and under A2 there is no per-id escape: only
`--allow-bare-claude-names`, which is global. The user cannot regenerate config until they either
accept the routing wholesale or remove the provider.

**What A2 changed about this scenario, and it is a large improvement.** Under revision 1's stripping,
the fatal also fired whenever the relay *co-owned* the id — a configuration where CCR returns
`undefined` and nothing binds. Those were false positives and they were the common case. Under A2 the
fatal fires **only when CCR would genuinely bind Claude Code's bare id to a reseller**, which is the
hijack itself. So the residual risk is no longer "the guard blocks a safe config"; it is "the guard
correctly blocks a dangerous one and the only override is coarse". That is a much better failure to
have, and blocking is the right behaviour.

**A vault provider named `anthropic` walks into this scenario unchallenged** *(B1, #23 + #25)*. This
scenario's own configuration is "the relay absent (down, or `--no-anthropic`)" — and
`assertRelayNameUnclaimed` fires **only inside the relay branch** (`run.mjs:659`), so in exactly this
configuration nothing checks the name. `checkBareCollisions` keys owners by provider **name**, so an
impostor named `anthropic` collapses into the relay's identity and the guard reports no collision
while it sole-owns a Claude id. #25 is why nothing else catches it: `validate()`'s alias-collision
rule cannot fire on duplicate names.

**This is newly load-bearing because of this plan.** Ship 0, R6 and R7 make the bare-**id** guard
exact and faithful to `resolve()`; leaving the provider-**name** guard conditional on the relay being
up creates an asymmetry that *reads* as coverage. And **R4 already opens `validate()`** to add V9, so
the fix has a host: move the name check out of the relay branch, or add it as a `validate()` rule
beside V9. **Folded into R4**, whose WRITES already covers it.

**The first concrete instance is unknown until R10's smoke run.** That is an honest statement of the
evidence, not a gap: the population of ids the resellers actually list is exactly what discovery
measures, and no artifact in this repo currently contains it. R10 is where it becomes knowable.

**Prevention.** Ship B lands before Ship D (§3), so the guard is in its final shape before anything
consumes discovery. R4's V9 lands before R7, because A2's fidelity depends on it. R10's smoke run is
cache-only and touches nothing, so the first evidence arrives before any build reads it.

**Detection.** R11's `--dry` is the gate: it reports the guard's verdict exactly as a live run would
enforce it (`run.mjs:776-779`), so the fatal is seen with nothing written. R13's census makes the
count explicit rather than incidental. **The cheapest check is to run the census over R10's cache
before R11 exists** — it needs only the discovered id lists and the guard, both of which are in hand
at the end of Ship C.

### Scenario 2 — a provider silently yields zero models

**The story.** `agentrouter` needs three WAF headers on every request, carried as extra
newline-separated lines in `headersTemplate`. A discovery parser that reads only the first line
sends one header, gets `401 unauthorized client detected`, and records `auth` — a plausible, boring
outcome nobody investigates. Or a provider returns `{"result": […]}` under an unanticipated key, the
envelope search finds no array, and the outcome is filed as `empty` because the two were collapsed.
Either way the provider falls back to one stale `testModel`, the coverage number still looks
respectable, and rule 3 — *discovery is exhaustive so no provider silently yields zero* — has failed
in exactly the manner it was written against.

**Prevention.** `headersFor` is **lifted** from `key-health.mjs:39-46`, not reimplemented (R8). Six
outcomes with `empty` and `unsupported-shape` structurally separate. `unsupported-shape` records the
top-level keys observed, so the next parse is a data change rather than an investigation.

**Detection.** **Zero `unsupported-shape` is a non-waivable gate** on R10 — coverage may be waived
with `--accept-coverage-delta`, this may not. The per-provider outcome table prints every provider,
so a zero is visible per-name rather than as a ratio. R8's offline fixture asserts the two-line
header case directly.

**Residual, stated rather than hidden.** `githubcopilot` and `youcom` have no listing endpoint that
exists, so a coverage report of 100% always means *100% of the 44 eligible*, never of 47, and must
print it that way. Providers standing on `testModel` or catalogue data only are counted separately —
folding them into "covered" is the exact false assurance discovery exists to prevent.

### Scenario 3 — the widened config changes which model actually answers

**The story.** Ship D lands and routing grows ~43×. Two independent mechanisms can silently repoint
traffic. **(a)** `anchorModel`'s final fallback is `built.picker[0].model` (`run.mjs:891`); if the
picker's ordering shifts — and R11 changes how the picker is selected and ranked — every one of the
six CCR profile tiers repoints to a different model with no message. **(b)** At width, a bare id
that previously matched zero providers and failed closed now matches exactly one and **binds**. The
user's session keeps working, answers keep arriving, and they come from somewhere else. Worst case
this compounds with #47's existing silent substitution, so the wrong-model answer is attributed to
the model the user picked.

**Prevention.** R13 asserts the anchor is byte-identical across the widening, recorded as an
observable rather than assumed. R6's D1 narrowing and R13's census bound the bare-binding surface:
Claude-shaped `hijackable` must stay 0 and every ambiguous bare id must fail closed. R1 traces the
substitution layer so "which model answered" is answerable at all before anything goes live.

**Detection.** The `--target live` apply is a **gated manual step requiring the user's explicit
authorization** — it writes the real `~/.claude/settings.json` and restarts the CCR gateway.
`built-rows.json` is written *before* any pruning, so a row lost to a transient failure is re-probed
rather than ratcheted away.

**The rollback half of that backstop is broken, and revision 3 leaned on it without checking** *(A7)*.
`assertOptionsComplete` throwing into the catch that calls `restoreSettings` is the named recovery
path — and until revision 5 `keysync/safety.mjs` appeared in **no WRITES list at all** *(measured: 0
references; **R19 now owns it**)*, while the
retention is measurably wrong: the only settings backup on disk is
`settings.json.uw-backup-20260905T090726`, from **Sep 5**. The Sep 6 backup was created and deleted by
its own run, exactly as **#46** measured (mixed stamp formats make retention delete the newest). #28
compounds it: the failure message names a path where a good backup does not exist.

**Ship D adds a live apply and R13b adds a second, each taking a backup its own run will delete.** So:

- **Do not present rollback as the Ship D safety net** until #46 and #28 are fixed. The honest
  statement is that the *detection* works (`assertOptionsComplete` throws) and the *recovery* is
  unreliable.
- **This is R19**, the first task in Ship D, serial before R11 and a hard gate on any live apply.
  *(Revision 4 stated it as a prerequisite with no number, no WRITES list and no ordering entry — and
  offered "or say so in the runbook", which made a prerequisite dischargeable by writing a sentence.
  **The runbook alternative is withdrawn.** R13b faced the identical deferred-to-nothing risk and got
  a number, a WRITES list, a gate and a position; this gets the same.)*

**The check that would have caught it cheapest:** diff the resolved model for a fixed selection
before and after the widening, using R1's method. One request, read back out of the request logs.

---

## 6. Test plan

**Runner is exactly `node --test "test/*.test.mjs"`.** There is no `package.json`; that invocation is
the runner. **413 tests pass today** *(measured this session)*.

### 6.0 The named delta — a green count is not the invariant (H3)

Revision 1 said "413 must stay green". That is wrong as an acceptance criterion, because **this
feature deliberately inverts existing guard assertions**, and a plan that demands an unchanged green
count invites an executor to preserve a test whose subject the design removed. The criterion is:

> **413, minus the seven enumerated inversions rewritten in place, plus the new tests each task
> names.**

Every rewritten test must carry, in its own body, the sentence saying which decision inverted it.
Enumerated by reading `test/denylist.test.mjs` *(read)*:

| test | what changes | why |
|---|---|---|
| `:293` "the fatal message only offers the relay for an id the relay can serve" | `claude-opus-4-8`, no `realIds` → no longer classifies → non-fatal | **D1** — not in `ANTHROPIC_FULL` |
| `:365` "the guard covers fable and the full RESERVED boundary class" | `sonnet.1`, `haiku_2`, `claude` stop classifying; `fable` survives as an alias | **D1** (3 of 4 ids) |
| `:375` "the guard and the denylist share one definition of Claude-shaped" | `sonnet.1`, `haiku_2` stop classifying; **the test's subject is gone** | **D1** — repurpose as R6's drift detector |
| `:501` "realIds omitted (default null) keeps the old broad RESERVED-only behaviour" | inverts, **and the title pins the removed behaviour** | **D1** — retitle, do not just flip the boolean |
| `…:562` "our own config auto-adding an unreviewed id must never launder a reseller's sole claim" | relay + tabiai both own the id → now `shadowed`, not fatal | **A2** — its stated rationale reverses |
| `:639` "the remedy for an uncurated hijack is review, not an unachievable restart" | same shape → non-fatal; the `routedNotVouched` **fatal** branch becomes unreachable | **A2** — becomes a *reporting* test or goes |
| **`:600` "END TO END: the sets the pipeline derives really do keep the FATAL path armed"** | `routingIds` contains `claude-opus-4-8`, so `owners = {anthropic, tabiai}`, size 2 → `shadowed` → `fatal: false` against its `assert.equal(r.fatal, true)` | **A2** — see the note below; **revision 2's enumeration claimed completeness and missed it** (H7) |

**`:600` deserves its own paragraph, because of what it is.** It is the end-to-end test written
specifically to catch the regression `3fa8025` fixed — **the regression A2 deliberately reverses** —
and its own comment reads *"Nothing exercised the WIRING, which is precisely where the regression
lived."* Inverting it is correct under A2 and it is also the single most dangerous edit in this plan,
because the test exists to stop exactly this class of change from passing unnoticed.

**Its replacement keeps the derivation and the construction, and changes only the verdict:** build
the sets through `deriveAnthropicSets` as it does today, assert the new **`shadowed`** outcome with
the relay named as co-owner, and **add a new fatal case built the same way with the relay absent** —
so the end-to-end path still has a case that goes fatal, which is the property the original was
protecting. Deleting it, or flipping the boolean without adding that case, would leave the wiring
untested again.

Plus one **rationale-only** correction: `:872` "relayOwned NEVER grows with live data — the invariant
the guard rests on". Its assertions still hold and stay; its title and comment claim it keeps the
FATAL path reachable, which A2 makes false (§1.1).

**Ship 0 carries its own delta, and it is empty of inversions.** R0's restructuring is
verdict-identical absent a case variant, and no existing guard test uses an uppercase model id
*(measured)*, so Ship 0 **adds eight tests** — three `#53` observables plus five for the B1
entry-counting fix — and inverts none. *(Measured as shipped: 413 → 421 pass, 0 fail, no existing
assertion flipped. "Two tests" was the pre-B1 figure; "seven" predates the relay-strip fixture.)*
The seven below all belong to R6 and R7.

**The enumeration is now seven inversions plus one rationale correction.** Revision 2 said six and
called the list complete; it was not, and the miss was the end-to-end test. Treat any future claim of
completeness here as requiring a re-derivation, not a re-reading.

Unchanged and worth stating, because they look like they should move and do not: `:250`, `:258` and
`:357` use bare `opus`, which survives D1 as an alias; `:317` uses `claude-opus-5`, which is in
`ANTHROPIC_FULL`; `:670` passes an explicit empty `realIds`, so it already exercises the narrowed
path; `:564`, `:578`, `:588` and `:629` are all already non-fatal and stay so under A2.

**`:900` — #22's regression test — must be re-verified, not assumed.** It is the one test written
specifically to fail on the alias hole, and both D1 and A2 touch the function it guards. Confirm it
still fails under its original mutation (removing the alias exemption) after both land.

### 6.1 The standing convention

Pure logic is extracted as an **exported testable function** — the precedents are
`checkBareCollisions`, `deriveAnthropicSets`, `orderNativePickerOptions`, `validateBucketTable`, and
each exists because the pipeline cannot be driven from a test (it reads the vault, spawns PowerShell
for 44 credentials, and parses a 19.7 MB catalogue), so logic left inline is logic nothing can assert
on. New extractions in this plan: `joinCatalogEntry` and the relocated `priceOf` (R5),
`classifyOutcome` and `headersFor` (R8), the `--verified-only` filter (R12), the provenance ranker
(**R13b** — *J2: revision 3 attributed it to R11 here while correctly naming R13b in §6.4; G2 moved
it*), and `padId` plus the provenance glyph selector (R16).

### 6.2 Unit

| Subject | Task | The assertion that must be able to fail |
|---|---|---|
| `admitId` denial classes | R2 | one test per denied class, each with a positive control that now admits |
| `inferTier` | R3 → `test/infertier.test.mjs` | **rows `buildProviders` emits** move off `unknown` (not the bundle-wide histogram — M8); a non-matching offer yields `unknown`, not `offers[0]` |
| V9 | R4 | exactly one problem, naming the provider and the bypass |
| the join ladder | R5 | one test per rung, and the bare-name guard proving `orcarouter/auto` ≠ `morph/auto` |
| D1 classification | R6 | reseller inventions no longer classify; real ids still do |
| two-stage selector ownership | **R0** | the case-variant fatal, and the `Opus`/`opus` ordering proof that a fold-only implementation fails |
| the unstripped fatal set | R7 | four assertions in §4/R7; (b) is the false-positive proof and (c) the relay-absent proof |
| six outcomes | R8 | one fixture per outcome; `unsupported-shape` carries its observed keys |
| the routing/picker split | R11 | the two counts move independently |
| `--verified-only` | R12 → `test/verified-only.test.mjs` | routing counts identical with and without the flag (the extracted function, so this is a runner test — L9) |
| provenance producer | R14 | a listing-only model becomes a row; an empty `discovery` default removes none |
| refusal reasons | R17 | one test per reason code, asserting the **code**, not merely that the id was refused |
| the drill-in reducer | R18 | ctrl+r is a no-op on a zero-refusal provider and on a model row; the overlay closes on any non-arrow key |
| hostile-string rendering | R18 | an id refused **for carrying** `\x1b[2J`, and one for U+202E, reach the frame with neither intact |
| frame width | R16 | every line exactly 78 with the new column and a 37-code-point id |

### 6.3 Guard tests — the #22 rule, applied task by task

> A guard test that omits the production configuration is not a guard test.

`run.mjs` always calls `checkBareCollisions` with `realIds` as a non-null Set (`run.mjs:762`) and
`relayOwned` as the curated set. Every test that predates `3fa8025` passed `realIds: null`,
exercising a path production never uses — which is how 412 green tests certified a live hijack hole.

**Concretely, for this plan:**

- **R6 and R7 tests construct their arguments the way `run.mjs:762,771-772` does**: `realIds =
  new Set([...liveIds, ...ANTHROPIC_RELAY.models])`, `relayOwned` from `deriveAnthropicSets`,
  `relayRouting = routingIds`. A test that defaults any of the three is not counted as covering the
  guard.
- **R7's tests are driven through the same construction**, so the unstripped-fatal change is
  exercised against a guard configured as production configures it — not against a bare `{}`. This
  matters more under A2, not less: the change makes the guard's verdict track CCR's resolution, and
  a test that omits `relayOwned` cannot distinguish the two schemes at all.
- **R4's V9 test drives `validate()`** with a config `buildProviders` actually produced, not an
  object literal, for the same reason `normalizeModel`'s paired test exists: a literal can silently
  carry the wrong field name (`ctx` vs `contextTokens`) and stay green.
- **R11's split tests assert on a build**, not on a hand-written `{providers, picker}` pair.

### 6.4 Mutation testing (new boundary logic)

The practice has found real gaps twice in this repo. Required, with the mutation named and its
expected single failure recorded:

| Boundary | Mutation | Must fail exactly |
|---|---|---|
| R2 length cap | `128` → `129` code points | the over-length test |
| R5 bare-name guard | remove the prefix check | the `orcarouter/auto` test |
| R6 classification set | drop the `ANTHROPIC_ALIASES` disjunct | the bare-`opus` production-shape test (this is #22's own mutation) |
| **R0** fold stage | drop the case-insensitive retry | the case-variant fatal test |
| **R0** stage order | run the fold first, or drop the exact stage | the `Opus`/`opus` ordering proof |
| R7 fatal set | revert `fatal` to read `effective` | the relay-co-owns false-positive test |
| R8 outcome split | fold `unsupported-shape` into `empty` | the `{"foo":[]}` fixture |
| **R13b** ranker | reverse the provenance order | the picker-composition test. **Dead twice before this revision, for two different reasons:** revision 1 retired the cap outright, so the ranker changed row *sequence* but not *membership*; revision 2 restored the cap but left the ranking in R11, which has no provenance data to rank by (G2). It is live only in R13b, which has both a cap and a cache |
| R16 elision | drop the tail, keep head-only | the identical-rendering-groups assertion |
| R17 reason codes | collapse any two codes into one | exactly that pair's tests |
| R18 render sanitisation | remove the render-time `sanitizeDisplay` | the escape / U+202E frame test, and nothing else |
| R16 glyph selector | return the same glyph for two states | the no-colour distinctness test |

### 6.5 Live / integration — all gated

Nothing here runs without the user's explicit authorization.

1. **R9's two probes** — `xai` and `commandcode`, one listing request each.
2. **R10 smoke** — 4 providers, one request each, cache-only.
3. **R10 acceptance** — 44 authenticated listing requests, direct, never through the gateway,
   bounded concurrency 6, failure budget 3. Providers named; **no key logged, echoed, or written to
   any file, report, or output**.
4. **The `--target live` apply** (Ship D) — writes the real `~/.claude/settings.json` and restarts
   the CCR gateway. **Never run `node keysync/run.mjs --target live` without explicit
   authorization.** Preceded by `--dry`, whose collision verdict is identical to what a live run
   enforces.

### 6.6 Observability — what each ship must print

A number nobody prints is a number nobody checks. Required output, per ship:

- **A:** the tier histogram before/after (R3); the join-rate over the fixture corpus (R5).
- **B:** the guard verdict under `--dry`, with hijackable and shadowed counts, and for each finding
  whether the relay routes the id and whether it curates it (the reported distinction the stripping
  still computes).
- **C:** the full per-outcome table by provider; `unsupported-shape` count (must be 0); coverage as
  `N of 44 eligible`, with `testModel`-only and catalogue-only counted separately.
- **D:** `providers[].models` total vs picker row count (they must differ); the anchor before/after;
  the bare-ambiguity census.
- **E:** the snapshot line already printed by `menu/snapshot.mjs:main`, extended with a provenance
  histogram, the `discoveredAsOf` stamp, and **the total refused count broken down by reason** — the
  number whose absence is exactly what #51 is about. If it prints zero, that is a claim the reason
  codes are unreachable, and worth checking rather than believing.

---

## 7. Standing constraints — carried into every task

- **Never log, echo, or write an API key** into any file, report, or output. Providers by name only.
- **Never run `node keysync/run.mjs --target live`** without the user's explicit authorization.
- **`spike/research/` is gitignored and may contain keys** *(measured: `.gitignore:64`)* — never
  commit it, never read it into an artifact.
- **Fetch provider listings directly, never through the CCR gateway** (F2): `request_logs.url` is
  stored unredacted, Google's native listing carries the key in the query string, and capture policy
  is `requestLogBodyCapture: "errors"` over an error-dominated population.
- `redirect: "manual"` on every fetch; refuse non-https; refuse a query string on a listing URL.
- **Never schedule a privileged write** (F8): `refresh` is cache-only; `apply` stays manual and
  diff-then-confirm.
- **Never persist raw provider responses** (F7/F10) — allowlist projection at ingest.
- **Never build a cache path from a remote id** — hash it (F3c).
- A live-but-unpaid, bad-auth, or empty-listing provider is **never pruned or blocked**. Resellers
  are first-class.
- **Never infer capability from an id string.** Tri-state honesty: `true` / `false` / `null`, never
  `!!`.

---

## 8. Follow-ups this plan creates and does not close

| | Why it is not here |
|---|---|
| **D4 step 2** — the *non-sizing* half: whether the native `/model` menu should remain the surface it is, and how it renders | **the sizing is no longer here — R13b owns it.** What remains is a surface question, not a budget one: the native menu shows 10 rows with 1-row scrolling and no filter, and uwpick is the surface that goes wide. Nothing in this branch depends on the answer |
| **#50** — replicate the bundle merge from its three public upstreams, and refresh discovery, the bundle and the join on one clock | phase B, filed separately. It matters *here* only as the reason D3 keeps the bundle as **provenance-tagged enrichment rather than a dependency** — that framing is what makes #50 a source swap later instead of a rewrite. Keep the framing intact; scope none of the work. |

### 8.1 Deferred to a name, not to nothing (C)

The audit found four items this plan had deferred with **no citation and no successor**. That is the
failure mode `refresh/cli.mjs` is the monument to, so each gets both. None is folded in; all four are
genuinely out of scope, and saying *where* is the point.

| item | why not here | named successor |
|---|---|---|
| **#21 + report 20 §8.4/§8.5** — the key-lifecycle pillar: `chooseKeys` still throws on an unlisted multi-key provider, there is no `add` command, and **R9's `listing` migration is another hand-edit to `providers.json`** | this plan moves *away* from the pillar on R9 and should say so rather than imply neutrality. An `add` command is a feature, not a resolver fix | **phase B, first task after the refresher** — it consumes R8's cluster handling and R10's probe path, both of which land here. It should not start before Ship C |
| **DN-verify-ratchet, producer half** — R12 fixes the consumer; `verify-prune.mjs:113-117` still overwrites `working` with only this run's passes | R12's scope is `run.mjs`; the producer is a different file and a different failure (a ratchet, not a prune) | **`verify-prune.mjs`, in the phase-B refresher task that owns re-probing** *(revision 5: revision 4 pointed at "a task paired with #6's rename" — but that rename is itself deferred here as cosmetic, so the successor pointed at a deferral. The producer's real destination is whatever re-probes, because a ratchet is only fixable by something that probes again; that is the refresher, #17.)* |
| **#7** — `settings.json` security-critical fields unverified across the rewrite | it is a `safety.mjs` change | **folded in — it is fix 3 of R19**, no longer a successor |
| **#33 / #34 / #35 / #41** — structural test gaps | B5 shows #34 can make Ship E's width observables vacuous; the rest are suite hygiene | **#34 before Ship E** (B5); #33/#35/#41 to a test-hygiene task with no dependency on this branch |

### 8.2 What this plan changes without having said so

Two effects worth recording, because a reader tracking issues should not have to derive them:

- **#48 is materially reduced by R11, as a side effect.** ~1,501 rows currently resolve to `undefined`
  and fall through to a silent substitution; widening routing removes most of those dead selections.
  #48's remaining half — the picker not *saying* anything at selection time — is untouched.
- **#3's 95%-dimmed ratio inverts.** `routable: false` today covers ~1,501 of 1,588 rows; after R11
  most become routable, so the dim stops being the page and starts being exceptional again. **That
  changes what the picker looks like more than any render task in Ship E**, and it happens in Ship D
  where no render observable is watching. R16's rendering judgements should be made against a
  post-R11 snapshot, not today's.
| **Refresh cadence** (#17, #14) | D6 puts it in phase B; unblocker is a scheduling decision under F8 |
| **`--verified-only`'s name** (#6) | it becomes a labeller in R12; the rename is cosmetic and separable |
| **A `@verified` filter token in uwpick** | decisions doc §7.2 asked for filtering to be *"weighed against per-row markers"*; §2.4 did that weighing and **chose the marker**, because provenance is a per-row property and the question at selection time is per-row. The token remains a good complement and is **cheaper now that R18 opens the reducer** — deferred on the weighing, not on cost or reach |
| **#12** — hardcoded `CATALOG_FILE` with no `require.resolve` | pre-existing; touching it inside the join work would mix a crash-hardening change into a data change |
| **#4** — `buildAnthropicPickerRows` reads its fallback map via the prototype chain | one-line fix, unrelated file region; should ride a separate commit so its own test is legible |

**Not follow-ups from this plan — separately named branches (decisions doc §9).** Listed here only
so that an executor looking for "what comes next" finds the boundary rather than adopting the work:

| branch | what this plan hands it |
|---|---|
| **Compaction / context window** (§9.1; #19, #20, #37) | its data prerequisite. D7.1 lands real `limits.contextTokens` in the `ctx` column via the join (~80% of rows), so Approach A consumes a value that already exists rather than sourcing one. **Handoff correction, superseded twice — this is the current statement.** Revision 1 said D7 touches neither reducer nor `uwpick.mjs`; revision 2 corrected that to `uwpick.mjs` only; **#51 now puts `menu/pick-state.mjs` in scope as well** (R18). So the compaction branch must re-read **both** files, and plan Approach A's two-press state against a reducer that already owns a modal overlay. What R18 leaves there is small and disjoint from Approach A's needs — one nullable `refusals` field, one `ctrl+r` binding, one modal rule, one projection — so it is a re-read, not a merge conflict. |
| **Subagent model assignment** (§9.2) | nothing, deliberately. R1 confirms the **main-agent** path only, and R13 asserts the anchor did not move rather than choosing a new one. |

---

*No source was edited in producing this plan. Verified at authoring time: `git diff --stat` empty,
and `git status --short` showing only this file and its sibling `plans/model-resolver-decisions.md`
as untracked.*

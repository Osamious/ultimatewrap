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
  *"it wasn't CC subagents but the agent itself."* #47's in-scope half is **main-agent** substitution.
  An executor opening #47 must read past the title.
  **Corrected 2026-09-07** *(revision 10, #74, OQ-6)*: this bullet used to continue *"— an
  unresolvable selection falling through CCR policy 7 to `anthropic/claude-opus-5` — and that is
  exactly what D4 step 1 fixes."* **Both halves are withdrawn.** R1 measured the layer as **Claude
  Code's `env.ANTHROPIC_MODEL` winning over `settings.model`**, client-side and **unconditional**, so
  D4 step 1 does not fix #47. The scope boundary this bullet draws is unaffected — main-agent is in,
  subagent is out — and **#47 is not closed by anything in this branch**. See §1.2, §1.6.
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
`/v1/models`) but does not curate, sole-owned by one reseller.** The class is real; the instance this
passage used to name is not.

**Correction — this paragraph asserted the opposite of a locked decision** *(#58)*. Revision 5 read:
*"`claude-opus-4-8` is the named first instance; today it is non-fatal only because tabiai and
gorouter both list it and neither is in the bundle, so both stand on one stale `testModel` each.
**Discovery removes that accident.**"* The final sentence is wrong, and wrong in the direction that
breaks a pillar. **Discovery removes nothing here**: D3 §4.1 locks *"`testModel` always survives
regardless of the listing"*, so after discovery tabiai and gorouter both still own `claude-opus-4-8`,
`|owners| = 2`, and it stays `shadowed` at `run.mjs:165`.

**The plan contradicted itself, and both passages could not ship.** §5 Scenario 1 already says
exactly this at M9 — *"D3 §4.1 keeps `testModel` regardless of the listing. So both still own it
after discovery and it stays `shadowed`"* — and dismisses `claude-opus-4-8` as an instance that
cannot fire. §1.1's ownership argument needed `testModel` **not** to survive; Scenario 1's dismissal
needs it to survive. **Scenario 1 matches the locked decision and stands unchanged; this paragraph
was the defect.**

**What the re-derivation costs, rather than absorbing it silently.** §1.1 loses its worked instance,
not its conclusion: the residual class stated above is unchanged, and the A2 analysis below rests on
the case table, never on `claude-opus-4-8`. **The first concrete instance is unknown until R10's
smoke run** — which is what Scenario 1 already states, and is why R13's census is the detection
mechanism rather than a name in this paragraph. This sentence also had a second life as a *licence*:
it gave an executor a sanctioned reason to accept tabiai and gorouter disappearing from a build. See
R11, where that is now blocked explicitly.

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
**That is false as written**, and I should have checked it.

**Corrected — the replacement below was itself wrong, in tense** *(revision 12)*. **What this
paragraph used to say**, immediately after the sentence above: *"`hijackable` fires only when the
relay is **absent** from the owner set, so `h.relayRoutes` is structurally always `false`, the
routes-but-does-not-curate suffix at `run.mjs:216` is unreachable, `routedNotVouched` at `:198` is
always empty, and the third remedy branch at `:204-209` is dead code."* That is a true statement
about the **destination** and a false one about the **origin**: at `65fd58a`, pre-R7, all three paths
were **live**. `effective = owners \ {relay}` let an unvouched `{relay, tabiai}` reach `hijackable`
carrying `relayRoutes: true` and `fatal: true`. Read as present tense it authorises deleting a
reachable branch. The corrected wording:

> **`hijackable` fires only when the relay is absent from the owner set — but only once `fatal` reads
> `owners`.** Today the unvouched branch classifies from `owners \ {relay}`, so `{relay, tabiai}`
> reaches `hijackable` carrying `relayRoutes: true`: the routes-but-does-not-curate suffix,
> `routedNotVouched`, and the third branch of the `remedy` ternary are all **live on `main`**, and the
> stripped verdict is precisely what keeps them reachable. Change 1 is what makes `h.relayRoutes`
> structurally false and strands all three. **They must therefore land in one commit.** Deleting the
> branch alone removes a reachable path — the only message that tells an operator why the relay's
> ownership did not count — and pushes those findings onto the "the relay does not serve this id"
> fallback, which would then be a false statement about a relay that does serve it. No test in the
> suite covers that, because the branch's own test asserts on message content that silently relocates
> rather than disappearing.

**That last clause generalises and is the reason this correction is worth its space: a deleted branch
whose output migrates to a fallback leaves message assertions green while the meaning inverts.** The
suite goes on matching the string; the string has stopped being true. A test asserting on message
*content* cannot distinguish "this branch fired" from "some other branch produced the same words", so
deleting a branch whose wording survives elsewhere is invisible to it. Coverage, not message
matching, is what catches this class — as R7's own mutation note already concedes for the reverse
direction.

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

- `providers[].models` = **`union(discovery ids, catalogue ids, testModel)`**, admitted and
  sanitised. **No cap** — this is what D5 retires. **The candidate set is a union, not the discovered
  set** *(#58)*. Revision 5 wrote *"every discovered model"*; fed literally into `buildProviders`
  that **removes** a provider whose listing returns empty rather than dimming it, which is a
  [[responding-provider-never-pruned]] violation with four named victims — the mechanism, the source
  line and the four providers are worked through in §4/R11. This is the same candidate rule R14
  already applies on the display side (§1.5a), so routing and display now agree by construction
  rather than by coincidence. A provider whose discovery outcome is `empty`, `auth`, `no-endpoint` or
  `error` keeps its catalogue and `testModel` rows.
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

**And it is a pillar-2 cost, named as one rather than left as a byte count** *(#64)*.
[[models-used-as-designed]] asks for the honest-minimal assumption where a model's capability is
unknown; `lH()`'s maximal set is the confident-wrong direction, and after R11 it applies to **~3,784
routing rows against 83 declarations** — roughly 3,700 rows asserting capabilities on no evidence.
This section books the pillar-1 benefit two paragraphs down (reach: rows that do not route at all
today start routing) and must book this against it: **step 1 buys reach at the price of ~3,700
maximally-assumed rows.** Both are real and the trade is still worth making — but it is a trade, and
a reader should not have to derive the second half.

**The mitigation is owned but not guaranteed.** R13b is the named owner of the shrink, which is
correct process. However **R13b's acceptance criterion is a byte/parse-time budget, not a
capability-declaration criterion**, and this section explicitly permits *"if the measurement justifies
only 83, R13b lands 83."* That outcome leaves the pillar-2 cost unmitigated in full. R13b now states
this at its own site, including that no successor task in this plan closes it.

Two things make step 1 a clear improvement anyway:

- Those rows do not route at all today. Degraded-but-working beats not-working under Principle 1.
- The status quo for them is worse than "undeclared": ~1,501 rows resolve to `undefined` and do not
  route. A loud, declared-maximal route replaces a selection that goes nowhere. *(This bullet
  previously ended *"…fall through CCR policy 7 to `anthropic/claude-opus-5` — the **silent
  substitution** in #47/#48."* That attribution is withdrawn — see the correction below. The
  resolution failure is real and measured; naming it as #47's mechanism was not.)*

**Correction, 2026-09-07 — R1 ran and falsified this paragraph. The substituting layer is not CCR's,
and the conditional this paragraph rests on does not hold** *(revision 10, #74, OQ-6)*.

**What this paragraph used to say.** *"This is now corroborated in the vendor's own words, not
inferred from behaviour. CCR's routing documentation describes the built-in Claude Code route as
detecting requests from Claude Code and routing **main** requests to the Claude Code Agent Config
model 'when the client has not selected a recognized model.' That is policy 7 stated by its author,
and the operative phrase is **recognized**: the ~1,501 unresolvable rows are the documented cause of
the substitution, not a symptom of it. It also fixes the direction of the remedy — widening the
recognized set is the fix, so D4 step 1 is not a workaround for #47 but its root-cause repair."*

**The layer is wrong.** It is **Claude Code's `env.ANTHROPIC_MODEL` taking precedence over
`settings.model`** — #47's open-question-1 **candidate 1**, which this section and §1.6 ruled **out**
in favour of CCR's `Router.builtInRules["claude-code"]`. Measured read-only against the live gateway:
**23 in-profile rows**, distinct `requestedModel` set exactly
`{anthropic/claude-opus-5, anthropic/claude-sonnet-5}`, with `settings.model` pinned to
`anthropic/claude-haiku-4-5-20251001` throughout and that id appearing in **zero** rows. The pin never
reaches CCR, so CCR cannot be the layer that replaced it. `x-ccr-routed-model` equals `requestedModel`
on **all 25** rows — **CCR rewrote nothing**. The substitution is resolved client-side, before the
request leaves Claude Code.

**The conditional is falsified too, and this is the load-bearing half.** The documented behaviour
substitutes *"when the client has not selected a **recognized** model."*
`claude-haiku-4-5-20251001` **is** recognized and routable — it is in the gateway's own allowed-models
list, which the gateway enumerates in its own 400 body — and it was **overridden anyway**. The
override is **unconditional**.

**Therefore D4 step 1 / R11 is not #47's root-cause repair, and that justification is withdrawn.** It
cannot be: **widening the *recognized* set cannot stop an override that fires regardless of
recognition.** R11 remains fully justified — on **reach**, [[route-max-working-models]], pillar 1:
~1,501 rows that do not route today will route. Only its #47/#48 justification goes. The remedy for
#47 is a disagreement between two fields of `settings.json` that keysync itself writes, and it is
**out of scope for this branch** (R1 is read-only; nothing here fixes it).

Full record: `plans/open-questions.md` **OQ-6**, committed at `77fd735`; issue **#74**. *(Still true
from the withdrawn paragraph, and retained: v3.0.22 is current, and the v1 router fields are gone from
both docs and source. Nothing in this plan references them.)*

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
labeller/orderer and routing keeps the full `union(discovery ids, catalogue ids, testModel)`. *(#58:
this said "every discovered model", the phrasing corrected in §1.2 and R11. It matters especially
here — this section exists to fix a **never-prune** violation, so leaving a candidate rule that
prunes an empty-listing provider would have re-introduced by the fix the class of defect the fix
addresses.)*

Two consequences to carry: the count branch at `run.mjs:715-717` can return to the normal
`EXPECTED_PROVIDERS + (anthropicOn ? 1 : 0)` expression, and the floor guard at `run.mjs:591-594`
still applies to `built.picker` alone. **Renaming the flag is deferred** — its name becomes wrong,
which is #6's own observation, but a rename is a separate, purely cosmetic change.

### 1.5 Item 5 — provenance persistence and badging

**Settled.** Snapshot `SNAPSHOT_SCHEMA` bumps **2 → 3**, adding a per-model
`provenance: "call-verified" | "config-asserted" | "listing-verified" | "catalogue-only" | null` and
a top-level `discoveredAsOf` stamp. The bump forces a rebuild via `loadSnapshot`'s existing schema
branch, which is the mechanism that stops an old file rendering silently wrong.

*(Revision 6, #59. The union was three-valued plus `null`; `config-asserted` was added between
`call-verified` and `listing-verified` because two populations — the vault `testModel` and the
relay's four models — were being assigned the top rung as a **config literal** with nothing ever
probing them. Decisions §4.1 carries the amendment and its reasoning. **The vocabulary is fixed
here, in the schema, deliberately**: this is the reason the fix lands now rather than deferring with
the rest of the freshness work, since shipping the wrong vocabulary in schema 3 would cost phase B a
3 → 4 migration or two meanings of one string.)*

**The badge column *is* touched, by exactly one condition** *(revision 9, #67)*. This paragraph read:
*"**The badge column is not touched.** It is fully spent on `FREE`/`FREE?`/`PLAN`/`PAID`/blank
(constraint 4). Provenance gets its own gutter — see §2."* Its second and third sentences stand and
are the operative ones — the badge set stays closed at five tokens, and **provenance never enters this
column**; it gets its own gutter, exactly as §2.3 designs it. The first sentence was falsified by
#67: `badgeOf` is the **second caller of `priceOf`**, and #55's all-zero rule (adopted in R3) reached
only the first. **R5b changes one branch inside `badgeOf`**, and 123 of today's 124 `FREE?` rows
render blank instead.

**No token is added to the badge set and none is removed.** A population moves from `FREE?` to the
blank that `menu/catalog.mjs:78` already defines as *"no evidence, guard G1, or price 0 with a
ONE-TIME grant"* — price-absence is the *"no evidence"* case, so this spends a meaning the column
already carries rather than widening it. Constraint 4 is untouched, and so is the §2.2 arithmetic
that treats `badge: 6` as fully spent.

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

**SETTLED BY MEASUREMENT, AND NOT AS THIS SECTION PREDICTED** *(revision 10, #74, OQ-6)*. R1 ran. It
was written as a confirmation of a documented mechanism and it **falsified** that mechanism instead —
which is what its own instruction to *"say so rather than fitting it"* asked for.

**The answer: Claude Code's `env.ANTHROPIC_MODEL` takes precedence over `settings.model`.** That is
#47's open-question-1 **candidate 1** — the one this section ruled out. The substitution happens
client-side, before the request is put on the wire. **CCR is not the substituting layer**:
`x-ccr-routed-model` equals `requestedModel` on **all 25** measured rows, `x-ccr-route-reason` is only
ever `default` or `custom-router`, and the pinned `anthropic/claude-haiku-4-5-20251001` appears in
**zero** of the 23 in-profile rows. It never reached CCR at all.

**And the conditional does not hold.** The documented behaviour substitutes *"when the client has not
selected a **recognized** model"*. The pinned haiku id **is** recognized and routable — it is in the
gateway's own allowed-models list — and was overridden regardless. **The override is unconditional**,
so no widening of the recognized set can suppress it. This is why §1.2's *"root-cause repair"* claim
for D4 step 1 / R11 is withdrawn there.

**What this section used to say, and why it was wrong.** *"Largely settled by the vendor documentation
cited in §1.2; what remains is confirmation, not discovery. #47's open question 1 offered two
candidates — Claude Code's `ANTHROPIC_MODEL` precedence over `settings.model`, or CCR's
`Router.builtInRules["claude-code"]`. The routing documentation names the second: the built-in Claude
Code route sends **main** requests to the Agent Config model when the client has not selected a
recognized model. `Router.fallback` is `mode: "off"`, so it was never that. R1 therefore shrinks to
one live confirmation, because documentation is not a measurement and this is the fact pre-mortem
scenario 3 rests on."*

It read the vendor's documentation as naming the layer, and then treated the reading as settled enough
that R1 became a formality. Two errors compound there: the documentation described a route that never
fires for this traffic, and the section's own caveat — *"documentation is not a measurement"* — was
stated and then not acted on. The `Router.fallback` observation stands and is retained; it simply
excluded a third candidate rather than confirming the second.

**Consequence, and the scope line.** The divergence is between two fields of `settings.json` that
**keysync itself writes** — `model` (the pin uwpick writes) and `env.ANTHROPIC_MODEL` (the anchor
keysync writes) — and it is resolved before any request is made. **Nothing in this branch fixes it**:
R1 is read-only and confirmation-only, and a remedy aimed at `Router.builtInRules["claude-code"]`
would miss entirely. Full record: `plans/open-questions.md` **OQ-6** (`77fd735`); issue **#74**.

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
| `call-verified` | `◆` | `#` | grn | a real completion returned 200, **dated** (`keysync/verified-rows.json`) |
| `config-asserted` | `◈` | `=` | yel | local config names it and nothing has probed it (vault `testModel`, the relay literal) |
| `listing-verified` | `◇` | `+` | cya | the provider's own keyed listing named it |
| `catalogue-only` | `·` | `.` | dim | only bundle metadata names it |
| `null` (never discovered) | ` ` | ` ` | — | no discovery run has covered this provider |

**Revision 6 split the top rung** *(#59; decisions §4.1 amendment)*. This table used to have four
rows, and `call-verified` was described as *"a real completion returned 200 (`testModel`,
`verify-cli.mjs`)"* while **being assigned as a config literal in two places that never probe
anything** — the relay's four models here in §2.3, and the vault `testModel` in R14. A lapsed
subscription, a revoked key or a decommissioned `testModel` would keep rendering the top rung of a
ladder defined by a 200 response, indefinitely, and the picker would rank that dead row **above** a
live `listing-verified` one. `call-verified` is now reserved for an **actual dated probe result**;
nothing in this branch assigns it as a literal.

**`call-verified` is defined but unpopulated in this branch, and that is deliberate, not dead
code.** The artifact that would feed it already exists — `keysync/verify-cli.mjs` writes
`verified-rows.json` with `generatedAt` and a `working[]` of models that returned 200 from a real
CLI completion — but wiring it into `provenanceOf` is **not in scope here** and is not scoped
elsewhere by this revision. R16 still renders the rung distinctly from fixtures, which is what keeps
the glyph honest for the day it is fed.

**The relay's four models are `config-asserted`, not `null`, and getting this wrong inverts the
whole column** *(A6, #45)*. `anthropic` is `listing: null` and is never discovered (R9), so a naive
`provenanceOf` returns `null` for it and R16 renders **blank — the bottom of a ladder whose top is
`◆`**. The four Claude models the user certainly has would then render *less* confident than a
third-party row marked `◆`, which is the exact inversion #45 already files against the picker.
**`config-asserted` sits above `listing-verified` for precisely this reason**: demoting the relay
past a third-party listing row would fix #59 by reintroducing #45.

`Object.hasOwn` catches a missing field, not a misleading value, so no R14/R15/R16 observable fails on
it. The justification is the one already in `menu/catalog.mjs`'s relay branch, which hardcodes
`tools/vision/reason: true` under the comment *"Every other all-true or all-false literal here was a
coercion; this one is a measurement."* That argument still carries the relay to the second rung —
these are the subscription models, known first-hand — but **not to the first**, because "known
first-hand" is exactly an assertion and not a measurement this system took. **R14 assigns them
`config-asserted` explicitly, and R16 asserts a relay row does not render blank.**

**This is a label change and never a prune.** Both demoted populations survive exactly as before:
the vault `testModel` still always survives regardless of the listing, and catalogue-only rows are
still kept and dimmed (D3 §4.1, unchanged). A reader taking the demotion for a removal would be
reading in a [[responding-provider-never-pruned]] violation (#58) that is not here.

Filled → filled-in-hollow → hollow → dot → blank is a legible ladder with `caps.colours === 0`,
which is the requirement `healthDot`'s own comment states and the requirement its predecessor
failed. `◈` (U+25C8, white diamond containing black small diamond) is the right shape for this rung
on its own terms: a filled claim inside a hollow shell is what an unprobed assertion *is*. **The
implementer must confirm each glyph measures one column under `vis()` and that
`test/style.test.mjs`'s exact-`FRAME_W` invariant still holds** — `◆`/`◈`/`◇`/`●` are all East-Asian
*Ambiguous* width, a risk this codebase has already accepted for `●◐○`; `◈` extends that accepted
risk to one more code point in the same block rather than opening a new class, but it must still be
checked rather than assumed.

**ASCII `=`, checked against the table** *(the distinguishability requirement, applied)*. In the
five-glyph ASCII column `# = + . ␣`, every pair is separable in a monospace gutter; the closest pair
is `=` against `+`, distinguished by the vertical stroke `+` has and `=` does not. `=` is also **not
currently a value anywhere in the ASCII glyph table** (`style.mjs:72-77`) — worth noting because `#`
is already `on` and `+` is already all four `frame` corners, so this rung is the only one of the
four whose ASCII glyph is unshared. Those two pre-existing reuses are positionally unambiguous (a
fixed-x gutter, as `healthDot` established) and are **not changed here**. One consequence to carry:
adding `=` to the ASCII glyph table removes it from the free list the `padId` elision marker draws
from below — which needs no new rule, because that constraint is already mechanical ("assert the
elision marker is not a value in the ASCII glyph table") and will simply exclude it.

**Colour `yel`, and the reuse is intentional.** `yel` already carries *provisional / unconfirmed* in
this picker — `FREE?` in the badge column and `needs $` on the health dot — so `config-asserted`
extends an existing meaning rather than introducing a fifth colour vocabulary (#3's objection).
Colour is never the sole carrier here in any case; the glyph is.

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

The staleness budget is what makes the marker legitimate at all. **The budget grants two clauses,
and this section previously answered only one of them** *(#59)*. It used to read: *"it passes
cleanly: all three levels fall out of the same 44 discovery calls that D6 already makes."* That is
the **cost** clause, and it is still true — every discovered rung falls out of D6's existing 44
calls, and nothing in the ladder requires the per-model completion probing the budget rejects
(~1,588 requests, costs money, decays in days). But the grant is for a label that is *"free, 44
requests, **and at the same cadence as provider health**"*, and the cadence clause went unanswered.

**Answering it honestly: there is no refresh clock, and there will not be one in this branch.**
`refresh/cli.mjs` is manual-invocation only, and D6 puts cadence and scheduling explicitly out of
scope for phase B. So `listing-verified` does not mean "named by the listing *now*"; it means
**"named by the listing as of the last time someone ran a refresh."**

**The deferral stands** — it is confirmed, not reopened here — **and it is legitimate because the
staleness is disclosed rather than hidden.** The budget tolerates old-and-dated; what it forbids is
wrong-and-unmarked. Two things carry that disclosure:

1. **The `discovered <date>` header stamp** (§2.3, R15, R16). This is what converts
   `listing-verified` from a bare claim into a dated one, and it is the difference between a stale
   label and a lying label. It is not decorative and it is not optional: R15 carries a **two-case**
   observable — populated cache writes a non-null stamp, absent cache writes `null` — specifically
   so a permanently-null stamp cannot pass (M13). A ladder whose freshness is deferred *depends* on
   that stamp, which is why the observable is written to fail.
2. **The user's stated phase-B plan: a single manual refresh command** covering model listings, the
   bundle, and the id matching in one run. Under a manual refresher the semantics are coherent —
   the user knows when they last refreshed because they are the one who ran it, and the stamp
   corroborates it on screen. Cadence becomes an explicit user action rather than an absent clock.

**This mitigation does not cover the §2.3 fix, and the asymmetry is the whole reason one half ships
and the other defers.** The stamp discloses *when discovery last ran*. A hardcoded `call-verified`
was **never discovered on any date**, so the stamp says nothing about it — a reader would see
`discovered 2026-09-06` beside a `◆` established by a string in a config file written months
earlier, and the stamp would be actively misleading rather than merely silent. Disclosure can carry
a stale-but-dated label; it cannot carry an undated one claiming to be dated. That is why the rung
split lands now and the refresh clock does not.

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

~~So `W.refused = 3` plus a one-column gap after `health` lands at **74 of 75, with 1 spare**~~ — that
was revision 10's form, and it left level 0 effectively full with a single spare column against §2.3's
two at level 1.

**Revision 11 — no new column. The two counts share the existing one.** Instead of allocating
`W.refused`, the existing **`W.count = 7`** cell renders `#MODELS/#WITHHELD` — `343/200` is exactly
seven characters, so the count of what a provider offers and the count of what is being held back
arrive in the space already reserved for the first. **Verified against `menu/style.mjs`:** `W.count`
is 7 today, the level-0 row allocates `2 + 30 + 7 + 3 + 6 + 1 + 11 + 1 + 1 + 8 = 70 of 75`, and this
change adds nothing to that sum. **Level 0 stays at 70 of 75 with 5 spare** rather than going to 74
with 1, so §2.3's two-column reserve at level 1 is no longer the tighter of the two. The header cell
still derives from the same `W` constants as the row, as `menu-layout`'s derived-offset test requires
— but it now renames one existing cell rather than adding one, which is strictly less that test can
disagree about.

**Overflow is a real hazard here and must be guarded explicitly.** `rpad` runs `sanitizeDisplay(s, 7)`
first, which **truncates from the right without any ellipsis**: measured,
`sanitizeDisplay("1501/1501", 7)` returns **`"1501/15"`**. That does not look clipped — it reads as a
plausible, wrong pair, which is precisely the failure
[[uwpick-shows-latest-functional-state]] forbids, and it is worse than the blank cell it would
replace. Any pair that cannot fit seven columns must be **abbreviated deliberately** (`1.5k/1.5k`
does not fit either; `1k+/1k+` does) rather than left to the truncating pad. **Observable:** a
fixture provider whose counts exceed seven columns renders a form that is either correct or visibly
abbreviated, and **never a truncated number** — assert on the rendered string, since this is exactly
the case a width-only assertion passes.

**Blank when zero** is retained but changes shape with it: a provider withholding nothing renders the
bare model count (`343`), not `343/0`. Positive-signal-only, the same discipline `capsOf` and
`makeRoutableOf` already follow — the separator itself is the signal that something is being held
back.

**(b) A drill-in from inside the menu.** **ctrl+r (`c0 === 18`)** on a focused provider row.
*(measured: bound control codes are 3, 6, 8/10/13/27/127 — 18 is free.)* A plain letter cannot be
used: level 0 sends `a-z0-9` to the filter, which is exactly why `ctrl+f` is a control key. The
detail is a **modal overlay in the `legend` pattern**, not a third navigation level — `frame()`
already renders one modal from `v.legend`, dismissed by any key, and reusing that grammar costs no
new interaction model. Windowed with the existing `… N more` line if a provider ever exceeds the
frame.

**Revision 11 — the keystroke is kept and a visible entry point is added beside it.** The modal and
the rejection of a third navigation level both stand; what does not stand is making the keystroke the
*only* way in. **#51 exists because refusals are invisible, and an undiscoverable keybinding is not a
fix for invisibility** — a user who never learns ctrl+r is in exactly the position the finding
describes. So the **model level gains a `WITHHELD LIST` first row** which opens the same overlay. One
overlay, two doors: a visible row for discovery and ctrl+r for speed, the same relationship the
favourite toggle already has with its own control key.

**Placement is at the model level deliberately**, and it is the same reasoning H3 used to extend
ctrl+r there: a user who notices models missing is looking at a provider's model list, not at the
provider index. The row sits **first**, above the model rows, where a reader scanning for "why is
this list short" meets it before concluding the list is complete.

**Vocabulary: `WITHHELD`, not `BLOCKED`.** See (c) below — the list is no longer predominantly a
security-refusal log, and `BLOCKED` would misdescribe the 1,501-row population that now dominates it.
The row is **suppressed entirely when the provider withholds nothing**, so it never appears as an
empty promise; this is the same blank-when-zero discipline the count cell in (a) follows, and it is
what keeps the addition positive-signal-only.

**(c) Per refused id: the id as advertised, and the specific reason.**

**Reasons have to be produced — `admitId` returns bare `null` for every failure.** A classifier is
needed, and **this is where D2's inversion pays a second time**: R2 replaces an allowlist with
*named rules*, so each refusal has a natural reason string (`escape-sequence`, `control-char`,
`invisible`, `traversal`, `backslash`, `too-long`, `leading-separator`, `uw-namespace`), where an
allowlist could only ever say "did not match". **R2 must land first**, and it does — Ship A.

**Revision 11 — `refused[]` widens from "refused by `admitId`" to "withheld, with a reason", and
this is the substantive change of the three.** As specified through revision 10 the list carries
`admitId` refusals only. **R2 took that population to ~0 of 1,588 uwpick rows**: the 14 ids it was
built to disclose are exactly the 14 R2 now admits. Shipped as written, the count cell in (a) would
read blank on every provider, the overlay in (b) would open on nothing, and #51 would be closed by a
feature that displays nothing. The fix is not to revert R2 — it is that the population was drawn too
narrowly.

**Measured populations, each with its denominator:**

| class | population | shown today as |
|---|--:|---|
| refused by `admitId` | **~0 of 1,588** rows, after R2 | nothing |
| **not routable / capped out** | **~1,501 of 1,588** rows *(~1,498 of these overlap the ~1,505 absent from `Providers[]`)* | dimmed, with no reason given |
| listing-absent | unknown until R10 reports | nothing |

**The middle row is the real population, and it is the one a user actually hits.** Its reason string
is *"not in the routing table: provider capped at 3 models"*. A row that is dimmed with no
explanation is the same defect as a row that is missing with no explanation — the user learns that
they cannot have it and not why — so it belongs in this list on #51's own logic.

**The reason must be able to change, because R11 largely eliminates this one.** Retiring the cap
moves most of those ~1,501 rows into `Providers[]` and they stop being withheld at all. That is the
point of R11 and is not a problem for this feature, but it does constrain the design: **the reason is
data, not a fixed vocabulary of security codes**, and the feature has to stay meaningful when its
largest current class empties out. After R11 the surviving classes are the `admitId` refusals, the
listing-absent rows, and whatever cap or filter remains — smaller, and still the honest answer to the
question the overlay exists to answer.

**This reframes the feature, and the framing should be recorded rather than left implicit.** It is
less a *security-refusal log* than a **"why can't I use this row" explanation**. That is why the
user-facing wording is **withheld** rather than *blocked*: `blocked` implies a defensive judgement
about a hostile id, which is accurate for ~0 of the rows and misleading for ~1,501 of them.
Internal identifiers may keep whatever names they already have; this constrains what the user reads.

**`fatal` collisions are explicitly NOT part of this list, and must not be folded in later.** A
bare-id collision **halts the entire run** — it does not hide one model from one provider. Putting it
in a per-provider withheld list would misrepresent a whole-config abort as one provider's missing row.
This paragraph exists so the question is answered before someone reasonably asks it.

**But excluding it from this list does not discharge the disclosure requirement, and §2.6 is where it
is discharged.** A fatal is near-silent today — one stderr `console.warn` — so "not here" would
otherwise read as "nowhere". §2.6 specifies the run-level record that covers it, along with the other
three ways a run refuses to write. The two surfaces answer different questions and neither substitutes
for the other: this list answers *"why can't I route to this row?"*, §2.6 answers *"was this
configuration applied at all?"*

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

### 2.6 Run-level disclosure: a keysync that refused to write, or wrote with reduced scope *(revision 11; widened, revision 12)*

**The gap.** §2.5(c) excludes `fatal` collisions from the per-provider withheld list and that
exclusion stands. But the standing requirement is that **nothing is dropped silently**, and a fatal
today is near-silent: one `console.warn` on stderr during a run nobody need be watching. The
exclusion says where it does *not* belong; it does not discharge the requirement. It needs a
different surface.

**Why it is not a per-provider row, recorded so it is not folded back in later:**

1. **It is not a property of a model.** Every withheld class in §2.5 answers *"why can't I route to
   this row?"* A fatal answers *"why was this configuration refused?"* — a property of a **run**.
2. **A per-provider rendering understates the scope by a factor of 44.** A fatal blocks the entire
   write. `tabiai: 1 withheld` says one provider lost one model when in fact **no provider updated at
   all** — the other 43 did not either.
3. **The remedy differs in kind.** Withheld → R11 widens routing, or the row is a mode, or the
   provider stopped listing it. Fatal → remove the provider, or pass a run-wide flag that disarms the
   guard for **every** id (#9).
4. **The picker renders the last *successful* state.** A fatal means the current attempt was refused,
   so any per-row label about it would describe a config **that was never applied** — a claim about a
   hypothetical, which the staleness budget forbids.

**A wrong reason that was proposed and must not be repeated:** *"a fatal prevents the snapshot
existing."* It does not. `menu/snapshot.mjs` builds `catalog/snapshot.json` as a **separate command**,
and `keysync/run.mjs` writes `built-rows.json` **before** the collision guard runs. Verified against
shipped source, **citing symbols because five more tasks write this file** *(see the A1 note in the
decisions doc)*: the unconditional `BUILT_ROWS` write executes at top level **before** the
`checkBareCollisions` block, whose `collisions.fatal` exit precedes the `--target` dispatch where the
config and settings writes begin. An artefact therefore **does** exist on the fatal path. The design
rests on the four reasons above, not on that one.

**A source comment is loose here and should be corrected by whichever task next opens the file.**
The comment immediately above the `collisions.fatal` exit reads *"Fatal BEFORE any write"*. That is
true of the **config** write and false of `built-rows.json`, which precedes it. A reader trusting it
concludes nothing is on disk after a fatal, which is exactly the wrong belief for the requirement
below.

**`built-rows.json` is NOT the failure record and must not be repurposed as one.** It is written
unconditionally on every run, before the verdict is known, and its content is the built picker rows —
i.e. it looks like a *successful build product*. Reading it as evidence of a completed run inverts the
signal. The record specified here is a distinct artefact.

**What to specify.** A run-level record the picker can render — in substance *"last keysync refused
to write — 2026-09-07, 1 collision"* — with a drill-in naming the provider, the id, and the remedy.
Requirements, each from a standing pillar:

- **It clears on the next successful run.** A resolved fatal must stop showing. This is what carries
  it past the staleness budget: keysync writes **and** clears it, so it refreshes exactly when the
  thing it describes changes — no probe, no cadence, no new clock, the same argument §2.5 makes for
  `rejected`.
- **Three states, honestly distinguished: refused / succeeded / never ran.** `absent` must not read
  as `no collisions` — the same absent-vs-empty discipline R15 applies to `refused[]` and to the
  `discovered` stamp.
- **It is dated**, for the reason the `discovered <date>` stamp is dated: visibly old beats silently
  wrong.
- **It is unmistakably a failure record, not partial config.** See the `built-rows.json` note above.
- **It gates and prunes nothing.** Disclosure only — [[responding-provider-never-pruned]] applies to
  a refused run as much as to a refused provider.

**Scope correction: collisions are not the only way a run refuses to write, and a record covering
only collisions is silently wrong on the others** *(measured)*. `keysync/run.mjs` has at least four
refusal exits before the `--target` dispatch: the `--verified-only` empty-picker floor (exit 2),
**the `validate()` `VALIDATION FAILED` exit (exit 1)**, the `collisions.fatal` exit (exit 1), and the
lock-acquisition refusal (exit 2). All four leave the config unwritten. If the record is written only on the
collision path, then after a validation failure the picker keeps rendering the **previous run's
success** — the precise failure mode this section exists to close, reintroduced through the back door.

**So the record is written on any refusal-to-write, and the collision is one *reason* among several.**
The reason is **data, not a closed vocabulary**, exactly as R14/R15 establish for `refused[]`; the
four reasons above are all properties of *a refused run*, and none of them is specific to collisions.
This is a widening of B4 as first stated, on the same evidence that motivated it.

**Second scope correction: the principle is not about refusal. A run that PROCEEDS with silently
reduced scope owes the same disclosure** *(revision 12, #81)*.

Everything above is written around a run that **stops**. R6 created the other shape and this section
did not cover it: the run **proceeds**, writes the config, exits zero — and the guard's own scope has
silently shrunk underneath it, because `realIds` came back `null` and the classification set narrowed
with it. Worse than quiet: with `hijackable` and `shadowed` both empty the caller's `console.warn`
**never fired**, so the operator saw **nothing at all** — not a reduced verdict, not a weaker one, no
line. An all-clear that is really "no findings among a set I could not verify" is a **claim about
Anthropic's catalogue made by a run that failed to reach it**.

**Generalise the principle accordingly: a control that narrows its own scope must say so, whether the
run stops or continues.** Refusal is one trigger, not the definition. The test is whether the artefact
a reader will act on still describes the thing they think it describes.

**And the corollary that made this reachable at all: a message nobody prints is not disclosure.** The
gap was not only missing text — the print condition itself was gated on there being findings, so the
one path that most needed a line was the one path structurally unable to emit it. A disclosure whose
emission is conditional on the very thing it exists to report the absence of is not a control.

**What shipped for this, at `7dae67e`**, recorded as the worked instance rather than as new
specification:

- a **`catalogVerified`** flag on the guard's return, false on exactly the `realIds === null` path;
- the empty branch's message **scoped** — "…among the ids this config advertises" — so it stops
  reading as an affirmative all-clear;
- an **`UNVERIFIED:`** line appended on **every** branch when unverified, not only the empty one: a
  shape-only `shadowed` note is as much a catalogue claim as an all-clear, and it is the branch
  today's config actually reaches;
- the print condition **moved out of the un-runnable entry block** into an exported
  **`shouldReportCollisions`**, with an unverified disjunct — this is the fix for the corollary above.

**It changes no verdict, and that boundary is load-bearing.** `fatal` does not read
`catalogVerified`; no new severity, no new exit path, nothing pruned. Disclosure only —
[[responding-provider-never-pruned]] applies to a run with reduced confidence exactly as it applies to
a refused one.

**This reverses a documented decision, and the reversal has to be argued rather than assumed.**
`menu/uwpick.mjs`'s comment above `framesFor` states: *"NO keysync state file is read here, and that is the design rather
than an omission"* — an earlier revision fed a picker banner from
`~/.uw/state/new-anthropic-models.json` and the coupling **was deliberately removed**. Rendering a
keysync run record re-introduces exactly that coupling. **It is still the right call, because the
comment's own stated reason for removal does not transfer:** that banner was removed for being
**vacuous** — *"the native picker now shows every live Anthropic id, so 'new id detected, not added'
no longer describes anything"* — not for being coupled. A record of whether the config the picker
reflects was **actually applied** is not vacuous; it is the one thing the snapshot cannot say about
itself. Whichever task lands this must **update that comment in the same pass**, or the next reviewer
will correctly cite it as a violation.

**It cannot ride the snapshot, and this is the load-bearing constraint on where it lives.** The
obvious economy — fold it into R15's `2 → 3` bump — **does not work**: the snapshot is built by
`menu/snapshot.mjs` as a separate command, so a keysync run that refuses to write does not rebuild
the snapshot. A record carried inside the snapshot would therefore be **stale exactly when it
matters**, still reporting the last successful run. The record must be its own artefact, written by
keysync and read by the picker alongside the snapshot. Sibling precedent already exists for the
convention — `keysync/key-health-latest.json` and `keysync/last-test-results.json` are status files
keysync writes and other tools read.

**Ownership — contended, and flagged rather than resolved here.**

| half | file | existing writers | earliest slot |
|---|---|---|---|
| producer | `keysync/run.mjs` | R0 *(Ship 0, committed)*, the Ship A fix pass *(committed)*, **R6 and R7 (Ship B)**, **R19, R12, R13 (Ship D)** | Ship B, serial after R7 |
| consumer | `menu/style.mjs`, `menu/uwpick.mjs` | **R16** (render), **R18** (overlay) | Ship E, serial after R16 |
| persistence | its own file — **not** R15's snapshot schema, per the constraint above | — | with the producer |

**Recommendation: it needs its own task, split producer/consumer, not a fold into an existing one.**
Three reasons. (1) **No existing task's WRITES spans both halves** — the producer is `run.mjs` in
Ship B, the consumer is `style.mjs`/`uwpick.mjs` in Ship E, and nothing owns both. (2) **`run.mjs`
already has five uncommitted writers** (R6, R7, R19, R12, R13); folding an unrelated concern into any
of them couples it to that task's security review, and R7 in particular is a `fatal`-computation
change that a reviewer must be able to assess alone. (3) The producer must land before the consumer,
a serialization no existing pairing provides.

**Proposed placement: producer as a new task at the end of Ship B (serial after R7, same
security-review checkpoint, since it reads the same `fatal` the guard computes); consumer as a new
task in Ship E, serial after R16 and parallel-safe with R18** *(different concern, but note both write
`style.mjs` — if they land in either order they serialize on that file, so state it rather than
discover it)*. The producer is inert until the consumer ships, which is a feature: it accumulates real
records before anything renders them.

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
| **A — additive** | R1 R2 R3 R4 R5 **R5b** | yes; nothing changes what routes — **R5b changes what one column *says*** on 123 rows, and routes nothing differently | ordinary review |
| **B — the guard** | R6 R7, **+ §2.6's producer half** *(proposed, revision 11 — serial after R7)* | yes; two edits to one function, plus a write-only failure record that nothing reads until Ship E | **security review** |
| **C — discovery** | R8 R9 R10 | yes; cache-only, wired to nothing | **security review** + live-run authorization |
| **D — widen routing (D4 step 1)** | R11 R12 R13, then **R13b** behind an internal gate | **no — one landing**, R11's intermediate state must not ship | **review + live-apply authorization**, and R13b reviewed separately |
| **E — uwpick (D7) + refusal disclosure (#51)** | R17 R14 R15 R16 R18, in that order, **+ §2.6's consumer half** *(proposed, revision 11 — serial after R16; serializes with R18 on `style.mjs`)* | yes; display and interaction only | ordinary review, **plus a security look at R18's hostile-string rendering** |

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
- **`menu/catalog.mjs` has exactly three writers, and they are strictly serial: R5 → R5b → R14**
  *(revision 9, #67)*. Verified by inspection of every WRITES line in §4: **R5** (the `priceOf`
  relocation only, Ship A), **R5b** (`badgeOf`'s price-absence branch only, Ship A), **R14**
  (`discovery`, `provenanceOf`, the union candidate set, `capability` → `outputKind` precedence, and
  `refused[]`, Ship E). No two may run as parallel lanes. `test/catalog.test.mjs` carries the same
  three writers in the same order. The three subjects are disjoint by construction — a relocation, one
  branch inside `badgeOf`, and `buildFrom`'s inputs — so serialization is the only constraint; none of
  them needs to see another's diff. **R5b is also serial before R3**, for a shared-rule reason rather
  than a file reason: see R3.
- **R3's ranking guard is PROVISIONAL until R11, and the picker is measurably worse in between**
  *(#62)*. The dependency order itself is correct and does not change — **R5 → R3 → R4 → R11**, with
  R3 three ships ahead of R11. What belongs in this list rather than only in R3's prose is the
  **consequence of that gap**: repairing `inferTier` reselects the top-3 for **21 of 118 providers**,
  and two of those reselections are regressions R3 cannot fix with the data it has — **cohere** trades
  three real chat models for two rerankers, and **google** *"re-creates the exact `google: lyria |
  veo-2` embarrassment it cites as its motivation"*. The cure is spending the live `capability`
  field, and R11 is the only task that spends it. **So from Ship A through Ship D the native picker
  carries measurably worse rows than today, and the ranking is repaired only at the widening** —
  against a governing caveat of *fix the ranking before widening anything*. R3's boolean gate is the
  only thing that says so in the interval, and a gate is a detector, not a fix. Recorded here because
  it is a property of the schedule; an executor reading R3 alone finds it filed as a task detail, and
  a reviewer choosing what may ship in between would not find it at all.
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
  `realIds` → `fatal: true`. ~~This one **cannot fail on `main`**, because `admitId` still rejects the
  id there; it becomes reachable only once R2 inverts the allowlist. Assert it in Ship 0 anyway —
  Ship 0 is where the guard is made faithful to `resolve()`, and a test that goes live when a later
  ship lands is the only kind that can catch a two-ship hazard.~~

  **Corrected, revision 11 (#78) — this was filed as a wrong *prediction*, and R2 has since landed,
  so it is now a wrong *description of shipped code*.** Observable (3) does **not** become reachable
  when R2 inverts the allowlist, and it never will: R2 denies **whitespace anywhere** by name,
  precisely because inverting to a denylist would otherwise have dropped that protection silently.
  Measured against shipped source: `admitId(" opus")`, `admitId("opus ")` and `admitId("o pus")` all
  return `null`. A whitespace-bearing id cannot reach the collision guard at all, so observable (3)
  is **permanently unreachable, not merely deferred**.

  **What to do with the test.** Keeping it as written yields an assertion that can never fail — the
  species this plan's own rule 15a forbids, since a test that cannot fail makes a real regression
  indistinguishable from a passing suite. Re-point it at the boundary that actually holds the
  property: assert that **`admitId` rejects the whitespace id**, which is where the defence now
  lives, rather than that the guard fires on an id that can never arrive. The two-ship hazard the
  original bullet worried about is closed by construction, not by a deferred test.

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

> **DONE — ran 2026-09-06, committed `77fd735` as OQ-6. The prediction below did not hold, and the
> task's own escape clause is what fired** *(revision 10, #74)*. The substituting layer is **Claude
> Code's `env.ANTHROPIC_MODEL` taking precedence over `settings.model`**, not CCR's built-in Claude
> Code route; and the documented conditional — substitute *"when the client has not selected a
> **recognized** model"* — is **falsified**, because the pinned `anthropic/claude-haiku-4-5-20251001`
> is recognized and routable and was overridden anyway. `x-ccr-routed-model` equals `requestedModel`
> on all 25 rows: **CCR rewrote nothing**. §1.2 and §1.6 are corrected; §1.2's *"root-cause repair"*
> claim for D4 step 1 / R11 and §8.2's *"#48 is materially reduced by R11"* are **withdrawn**. Read
> the body below as the method that was used, not as a live prediction.

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
~~Ship 0's observable (3) is the test that goes live the moment this task lands.~~ This is the one row
in the table whose omission is a security regression rather than a reach cost.

*(Corrected, revision 11 (#78). The struck sentence is the inverse of what this row does. Denying
whitespace is what makes Ship 0's observable (3) **permanently unreachable** — a whitespace-bearing
id is refused at admission and never reaches the collision guard, so the guard can never be observed
firing on one. Measured on shipped source: `admitId(" opus")` returns `null`. The correct reading is
that this row **retires** observable (3) rather than arming it; see the corrected bullet in the `#53`
observables above for what that test should assert instead.)*

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
**Serial after:** R5 (see the cycle finding below), then R5b. **Serial before:** R4, R11.
*(Revision 9: the R5b edge is not about files — R3 and R5b are write-disjoint. R5b lands
`hasPricedOffer` in `catalog-join.mjs`, and change 2 below **consumes it** instead of re-implementing
#55's rule at a second call site, which is the defect #67 exists because of.)*

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

  > ~~**No provider's top-3 acquires a row whose `modalities.output` contains any modality other than
  > `"text"`.**~~ **Withdrawn — revision 11. See below.**

  **Revision 11 — the replacement above is itself mis-specified, and the defect is in the
  observable, not in the code.** Three problems, all measured, and the second is the one that makes it
  unusable:

  - **It is ambiguous.** *"Acquires"* reads two ways — absolute (any such row is present in a top-3)
    or delta (a row present now that was not before). The two readings disagree, and only the
    delta reading was intended.
  - **Under the absolute reading it can never pass.** `nscale`'s entire catalogue is image models;
    `aws-polly`, `voyage`, `elevenlabs`, `fal-ai` and `fireworks-ai-embedding-models` likewise hold
    no text-output row anywhere. Their top-3 is non-text **by construction**, and rule 1 — never
    prune a responding provider — keeps those rows deliberately. A gate that fails on them is
    measuring the catalogue, not the change.
  - **The strict predicate — "contains any modality other than text" — flags a model it must not.**
    `openai/gpt-5-nano` declares `["image", "text"]`: a text model that also emits images. Demoting
    it would be a straightforward reach loss.

  **The corrected observable, and the one to implement:**

  > **A loose predicate — `modalities.output` lacks `"text"` entirely — evaluated only over
  > providers that hold at least one text-output row.**

  Both halves earn their place. **Loose, not strict**, so a multi-modal text model like
  `openai/gpt-5-nano` is not flagged for emitting images alongside text. **Scoped to text-holding
  providers**, so a provider with no text models anywhere is out of scope rather than a permanent
  failure. The gate then fails **exactly when ranking is at fault** and not when a provider simply
  has nothing text-shaped to rank — which is what a gate on R3 is for.

  **The measured state today, every number with its denominator** *(this is the count
  `keysync/keysync.mjs`'s `buildProviders` comment also carries; the two must not drift)*: **4 of 44
  built providers and 5 of 83 picker rows** carry a row whose `modalities.output` holds a modality
  other than text — `openrouter/auto` and `kilo/auto` (`["image", "text"]`), `openai/gpt-5-nano`
  (`["image", "text"]`), and `nscale/flux.1-schnell` and `nscale/stable-diffusion-xl-base-1.0`
  (`["image"]`). Under the **corrected** predicate the first three carry `"text"` and are not
  flagged, and the two `nscale` rows fall outside the scope because `nscale` holds no text-output row
  — so the corrected gate is **satisfiable on today's data**, which the strict one was not.

  **This must not be "fixed" by making the old gate pass.** Pruning `nscale`'s rows to turn the
  number green would violate [[responding-provider-never-pruned]] for a metric's sake. The number
  above is the honest reading; the gate is what changes.

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
**Serial before:** R5b, R3, R4, R11, R14. **This is the shared helper every later lane needs — the
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
measurement fixture only — never as a runtime source**. Expected observable: **65.0% of the 3,784
distinct live (provider, model) pairs, across 42 provider roots, join under the §4.3 same-provider
guard — 2,460 pairs**; and `orcarouter/auto` does **not** join `morph/auto`. Then
`node --test "test/catalog-join.test.mjs"`.

**What that observable measures, stated because the previous one did not** *(revision 10)*. It is the
**guarded** rate: the join with §4.3's same-provider guard applied, on the denominator of **3,784**
distinct (root, id) pairs. It is **not** the loose rate. The two are 577 pairs apart and both are
real:

| matcher | pairs | rate |
|---|--:|--:|
| **guarded, per D3 §4.3 — what this task ships** | **2,460 / 3,784** | **65.0%** |
| loose, no guard — reproduces the locked "3,046 (80%)" | 3,037 / 3,784 | 80.3% |

**What this observable used to say, and why it could not pass** *(revision 10)*. It read *"≥75% of
the 3,784 live (provider, model) pairs join (locked figure 80%)"*. **R5 shipped at `77c9cc6` and this
observable failed.** The cause was **not** the implementation: a §4.3-compliant join cannot reach 75%,
because the 80% locked figure was produced by a **provider-free** matcher — one with no provider in
hand, which by construction cannot obey the same-provider guard. Decisions §1's rung table reproduces
exactly (42.8 / 45.2 / 47.0 / 64.6 against its own 43 / 45 / 47 / 65) **only** under that
provider-free matcher. So the threshold was measuring one thing and the task shipping another.
**Decisions §1 is amended to label its ladder; §4.3 governs; and the threshold here moves to the
measured guarded rate.** Nothing about R5's code is implicated, and this observable is not a
loosening — it is the correct denominator's correct number.

**The guard stays — the user's decision, recorded at decisions §4.3 and §1 amendment 1** *(2026-09-07)*.
The 577-pair gap is real reach and is **not** paid for with a cross-provider guess: it closes at
**Ship C, from first-party listing data**. The uniqueness-gated rung that would have recovered 447 of
the 577 (76.8%) was measured and rejected — **168 of 458 multi-provider ids (37%) disagree on `ctx`**,
so a recovered row inherits one arbitrary vendor's context window. Do not re-open this on reach
grounds.

---

**R5b — `badgeOf` stops reading an absent price as `FREE?` (#67, #55).** *(revision 9)*

**WRITES:** `keysync/catalog-join.mjs` (one added export; `priceOf` itself unchanged),
`menu/catalog.mjs` (`badgeOf` only), `test/catalog-join.test.mjs`, `test/catalog.test.mjs`.
**Serial after:** R5. **Serial before:** R3, R14.

> **SHIPPED — `e3667be`.** *(Revision 10: the record below is what happened, not what was predicted.
> The design body that follows is retained as the reasoning that produced it.)*
>
> - **`hasPricedOffer` lives beside `priceOf` in `keysync/catalog-join.mjs`** and is **shared by both
>   callers**, as designed — one owner of the #55 rule rather than two implementations of it.
> - **It reads the whole offers array, and that stayed load-bearing in the shipped form:** on the sole
>   survivor the **matched** offer *is* the `0/0`. A predicate trusting the matched offer would have
>   blanked the one row that must keep its badge.
> - **The predicate's asymmetry is now stated where it ships:** `true` is **proof of pricing**;
>   **`false` is evidence of absence and not proof of it.** The named exception is a **genuinely free
>   routing mode** — a provider offering its `auto` mode at no charge — which is real and is
>   **deferred to #75**, folded into R14 above. Until then a free mode reads as price-absent, which is
>   the honest-minimal direction rather than a confident-wrong one.
> - **The corpus assertion shipped bundle-independent, not as an absolute count.** Pinning literal
>   totals would make the suite fail on the next CCR bundle rather than on a regression — report 08
>   F9's hazard, applied to a test.
> - **The fixture gained `acme-free-1`, the mistral shape**, because `test/fixtures/catalog.json`
>   **could not previously express a genuinely-free row** at all. Without it the discriminator is
>   untestable and the whole zero-price branch is satisfiable by returning `""` unconditionally.
> - **Measured effect: `FREE?` 124 → 1 across 1,588 rows**, sole survivor
>   `mistral/labs-devstral-small-2512`.

**Why a sibling task and not a fold, in one sentence each.** Folding into **R3** is the tempting fit
because R3 owns the #55 rule — but R3's WRITES is `keysync/keysync.mjs`, its observable is a
picker-membership diff, and the plan already flags it as *"three changes, not one"*; a fourth change,
in a different file, on a different surface, with a different observable, is what makes a task's
review unattributable. Folding into **R5** is worse: R5 is the shared helper four tasks depend on and
its whole value is being a **behaviour-preserving relocation**, so putting a user-visible change to
123 rows inside it means a revert of the join takes the badge fix with it. So: a small sibling,
landing between them, owning one condition.

#### The finding

#55 established that the bundle encodes *"not priced per token"* as `{input: 0, output: 0}` under a
token `sourceUnit` — **shape-identical to a genuine free tier**. R3 fixes the `inferTier` caller. It
does not fix the other one.

```
priceOf's callers          R3 fixes it?   writes
  inferTier / selection sort   yes         keysync/keysync.mjs
  badgeOf                      NO          menu/catalog.mjs      <- #67
```

**Measured against `catalog/snapshot.json`'s 1,588 rows joined through `loadCatalog()`** *(team lead,
this session)*: badge tally `{"": 925, "PAID": 535, "FREE?": 124, "PLAN": 4}`; of the 124 `FREE?`,
**123 have every offer zero** (the #55 shape, price absent) and **1 has a non-zero offer** (a real free
tier). None has zero numeric offers. So **123 of 124 `FREE?` badges assert a price the bundle does not
contain.** Live instances: `openai/omni-moderation-latest`, `openai/text-moderation-007`,
`mistral/mistral-moderation-2603`, and `google/lyria-3-clip-preview` — the compound case R3 already
names, misread as text *and* as free.

**Corroborated bundle-wide** *(measured this session, independently, wider scope: every provider in
`byProvider`, not only credentialled ones)*: **245 `FREE?`, of which 244 all-zero and 1 genuine.** The
two scopes differ in denominator and agree exactly on the discriminator — the same single genuine row.

**The question mark is not the disclosure.** `menu/catalog.mjs:75` defines `FREE?` as *"price 0,
cadence unknown"*. The hedge is about whether the grant **recurs**, not about whether price data
**exists**. A user reads *"probably free, might not stay free"*; on 123 rows the truth is *"we have no
price for this model"* — and the wrong reading is the reassuring one, on the axis a user makes cost
decisions with.

**Pillar bearing.** The staleness budget takes down a label that *"might go stale and be wrong most of
the time, misleading the user"*. This one is wrong **99.2% of the time it appears**, and not by going
stale — it was never right. Its only refresh is a global `npm i -g` of the CCR bundle (live
`catalog.generatedAt` = `2026-08-24T12:22:28.162Z`), which is report 08 F9's recorded hazard.
[[uwpick-shows-latest-functional-state]]

**Precedent is already in the file.** `menu/catalog.mjs:66-71` carries **GUARD G1**, which suppresses a
zero-price badge for non-text output. The file already accepts that a zero price can be meaningless
and must be gated — it gates on **modality** and not on **price-absence**. This adds the missing half.

#### The change

One predicate, landed once in R5's module so that R3 and `badgeOf` **share one owner of the rule**
rather than implementing #55 twice — the same discipline §2.5 applies to the sanitised-id shape, and
the same rule R5 itself states about helpers two lanes need:

```js
// keysync/catalog-join.mjs, beside priceOf
export function hasPricedOffer(entry)   // true iff some usable offer is non-zero
```

Then in `badgeOf`, inside the existing `p.in === 0 && p.out === 0` branch, **beside G1 and before the
cadence branches**:

```
if (!isTextOut(entry)) return "";        // G1  modality
if (!hasPricedOffer(entry)) return "";   // G2  price-absence  <- #67
```

**The ordering against cadence is deliberate.** `cadence === "recurring"` returns the hard `FREE`
claim; a provider-level grant cadence says nothing about a model the bundle never priced, so G2 must
precede it. No measured row reaches that path today (the tally has **zero** `FREE`), which is why this
is stated rather than observed — it is the branch that would make the defect worse the first time a
provider profile gains a recurring cadence.

**The predicate reads the whole offers array, not the matched offer, and that is load-bearing.**
`priceOf` matches by provider with `.find()` (`menu/catalog.mjs:57`), so on the one genuine row —
`mistral/labs-devstral-small-2512`, offers `[mistral 0/0, mistral 0.1/0.3]` *(measured)* — the matched
offer **is** 0/0 and the entry is nonetheless genuinely priced. A discriminator trusting the matched
offer would blank the single row that must keep its badge. *(That two same-provider offers resolve by
`.find()` order is a real separate defect in offer matching; it belongs to R3/#55's territory and is
**not** touched here.)*

#### Verify

`node --test "test/catalog-join.test.mjs" "test/catalog.test.mjs"`. Expected observables, and the
**123/1 split is the fixture basis** — both halves are required, because a fixture carrying only the
all-zero case is satisfied by returning `""` unconditionally from the zero branch, which would delete
the genuine free tier along with the lie:

- an entry whose every usable offer is `{input: 0, output: 0}` under a token `sourceUnit` badges
  **`""`** — the 123-row shape, fixtured from `openai/omni-moderation-latest`;
- an entry with a matched `0/0` offer **and** a non-zero offer elsewhere in the array badges
  **`FREE?`** — the 1-row shape, fixtured from `mistral/labs-devstral-small-2512` with its real
  `[0/0, 0.1/0.3]` array. **This is the discriminator; the task fails without it.**
- `PAID`, `PLAN`, G1-blank and the `cadence === "recurring"` → `FREE` paths are **unchanged**, asserted
  individually, so the diff is provably one branch wide;
- a corpus assertion over the snapshot join: **`FREE?` falls from 124 to 1**, and **`PAID` (535),
  `PLAN` (4) and the total row count (1,588) are unchanged** — the blanks absorb exactly the 123.
  ***As shipped this assertion is bundle-independent*** *(revision 10)*: it asserts the **relation** —
  every surviving `FREE?` has a non-zero offer somewhere in its array, and `PAID`/`PLAN`/total are
  unmoved — rather than the literal 124/1/535/4/1,588. Those numbers stay here as the **measurement
  that motivated the change**; a test pinning them fails on the next CCR bundle instead of on a
  regression, which is report 08 F9's hazard applied to the suite.

**Mutation check** *(§6.4)*: **deleting the `hasPricedOffer` line must fail the first corpus
assertion and the `openai/omni-moderation-latest` fixture, and nothing else.** Inverting it (badging
blank when a price *is* present) must fail the `mistral/labs-devstral-small-2512` fixture. Two
mutations, two distinct failures — a single-mutation check here would pass on a stub that blanks the
whole branch.

**Secondary observable — a second-order effect, measured, and the existing contract already predicted
it.** `buildFrom`'s provider row carries `free: priced ? …FREEISH… : null` under the comment *"`0
free` is a measurement, `no price data` is the absence of one"* (`menu/catalog.mjs:244-245`), where
`priced` is *some model has a non-blank badge*. Blanking the 123 therefore moves provider-level
counts, and **bundle-wide this flips 25 providers' `free` from a number to `null`** *(measured:
`gitlab` 23/23, `ollama` 14/14, `kenari` 8/8, `publicai` 8/8, `umans-ai-coding-plan` 8/8,
`sagemaker` 6/6, … all-`FREE?` catalogues)*, and merely lowers it for 23 more (`nvidia` −34,
`opencode` −20, `kilo` −19, `openrouter` −18, `requesty` −12, …). **That is the fix working, not a
regression**: those providers have no price data, and `null` is what that comment already says the
cell must show. Assert one flip-to-`null` provider and one merely-lowered provider, so the effect is
pinned rather than discovered later at the picker.

---

### Ship B — security review checkpoint

---

**R6 — D1: the classification set is `ANTHROPIC_ALIASES ∪ (realIds ?? advertised RESERVED-shaped ids)`.**

**WRITES:** `keysync/run.mjs`, `test/denylist.test.mjs`.
**Serial before:** R7, R12, R13.

**Serial after R0**, which is the first writer of `keysync/run.mjs`.

**This section describes what shipped, which is not what it specified** *(revision 12, #81)*. R6
landed the narrow form at `65fd58a`; Ship B's review measured it; the user **reversed the null
branch** at `7dae67e`. **What this section used to say**, in the heading and first paragraph: *"the
classification set becomes `ANTHROPIC_ALIASES ∪ (realIds ?? ANTHROPIC_FULL)`. … Change the
null-fallback at `run.mjs:126` from broad `RESERVED` to the curated set."* The decision moved under
the task; the rewrite below is the task as it now stands. The full measurement and the reasoning are
in decisions §2 amendment 1 and are not restated here.

**The shipped change.** Nothing else in the guard changes. **R0 has already restructured ownership
around the selector set**, so this task touches only what populates that set — and after the reversal
the null branch populates it from **the advertised `RESERVED`-shaped ids**, as it did before R6, while
the non-null branch is `realIds` unchanged. Both sides are trimmed. Net of the reversal, R6's surviving
substance is the disclosure work (§2.6) and the test rewrites, not a narrowing.

**Revision 1 said "`realIds` effectively never goes null", and that was self-cancelling** *(M6)*.
`run.mjs:762` sets it to `null` whenever `liveCatalog` is falsy, and `:626` prints
`UNAVAILABLE (relay down and no cache)` on exactly that path. **That path is the reason D1 was
argued** — and, after the reversal, it is the reason the branch is broad: the narrowing premise
("Claude Code never emits a name Anthropic has not published, so the curated set suffices") is
**unavailable exactly there**, because the thing that would establish it is the fetch that just
failed. A network failure is not evidence about the config's risk in either direction; the branch
resolves that by classifying widely and **disclosing** the reduced confidence (§2.6).

**`RESERVED`'s status differs by branch, and the earlier write-up was true of only one of them**
*(H3, corrected revision 12)*. This section used to state flatly that `RESERVED` *"becomes a no-op
inside this function"*. That holds on the **non-null** branch only:

- **Non-null branch — inert.** Ownership is computed by iterating `ANTHROPIC_ALIASES ∪ realIds`;
  every candidate is already in the classification set and `RESERVED.test()` cannot reject any of
  them. **R0, not R6, is what makes it inert there.**
- **Null branch — live and decisive. `RESERVED`'s output *is* the selector set.** The fallback is
  "every `RESERVED`-shaped id the config advertises", so the regex is not filtering a set someone
  else chose — it **constitutes** the set. Widening or narrowing `RESERVED` moves the guard's scope
  on this branch directly.

**Measured, and the swing is the point** *(#81)*: deleting the pre-filter killed **0 of 494** tests
under D1 and kills **8 of 502** now. A line went from provably dead to load-bearing without a diff of
its own. Any future task that touches `RESERVED` must read this distinction first — "it's a no-op"
was true when written and is now false on the branch that reaches production during an outage.

**Keep it, and keep the drift detector that makes the inert branch safe.** Removing it would leave
`isReserved` with a single consumer, lose the one place the two definitions are compared, and — after
the reversal — delete the null branch's selector source outright. The drift test asserts that **every
id in `ANTHROPIC_ALIASES ∪ ANTHROPIC_FULL` matches `RESERVED`**: if someone adds an id to
`ANTHROPIC_FULL` that `RESERVED` does not match, the pre-filter drops it before classification and the
guard goes silent on a real id. That is precisely the drift `denylist.test.mjs:375` was written to
catch, preserved after its original subject disappears. **The test must assert the claim, not only its
premise** — as shipped it now covers both branches (inert where selectors are constants, decisive
where they are advertised), because the earlier version proved the premise, never touched the claim,
and passed under a title that stood in for an assertion it did not make.

**Verify:** `node --test "test/denylist.test.mjs"`, plus a census over a synthetic widened config
built from the listing corpus. Expected observables: a reseller sole-owning bare `opus` with the relay
down is `fatal: true`; a reseller sole-owning a real uncurated Anthropic id is `fatal: true`; **a
reseller sole-owning any of the 15 ids in `ANTHROPIC_ALIASES ∪ Anthropic's live /v1/models` is
`fatal: true` with the relay down** — the independent threat set, sourced outside the guard per
decisions §10; the null path emits no affirmative all-clear and carries its `UNVERIFIED:` line; and
the drift detector passes over the live constants on both branches. **The "23 reseller inventions no
longer classify" observable is withdrawn**: those 23 were counted over the full bundled catalogue,
which this guard is never handed, and on the null path the shipped guard **does** flag inventions of
that kind when sole-owned — the accepted cost, not a regression.

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

**This is where the join gap closes, and it closes with first-party data** *(revision 10)*. R5's
guarded join reaches **2,460 of 3,784 pairs (65.0%)**; the **577 pairs** it refuses are refused by
D3 §4.3's same-provider guard, which the user confirmed stays (decisions §4.3, §1 amendment 1). Those
pairs are not recovered by loosening the matcher — they are recovered **here**, because R8's KEEP list
already persists **`contextLength`** and **`capabilityRaw`** per model **from each provider's own
authenticated listing**. A bare id served by 24 providers needs no cross-provider guess once each
provider states its own window.

Recorded so nobody re-litigates the guard later on reach grounds: the alternative — a
uniqueness-gated rung recovering 447 of the 577 (76.8%) — was measured and **rejected**, because
**168 of 458 multi-provider ids (37%) disagree on `ctx`** (`inkling`: six values, 65,536 to
1,048,576; `mimo-v2.5-pro`: four across 24 providers). Loosening buys reach by attaching an arbitrary
vendor's number to a row; Ship C buys the same reach with the provider's own. **The reach is deferred
to this ship, not surrendered.**

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
  6; **a failure budget stopping after 3 consecutive auth failures — per-provider, and never global**
  *(#61: revision 5's phrasing was ambiguous, and only one reading is permitted. The counter is keyed
  by provider and resets per provider; an exhausted budget stops **that** provider's requests and no
  one else's. A **global** budget would let three unrelated expired keys curtail the fan-out for all
  44 — [[responding-provider-never-pruned]]: auth failure is state to surface, not a reason to stop
  reaching everyone else)*; a scrubbed environment
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

**This task moves *away* from the key-lifecycle pillar, and says so here rather than only in §8.1**
*(#63)*. §8.1's deferred-items table already carries the admission — ***"R9's `listing` migration is
another hand-edit to `providers.json`** | this plan moves *away* from the pillar on R9 and should say
so rather than imply neutrality"* — but that sits ~900 lines from where an executor actually reads,
while this body framed the same hand-edit as compliance-by-precedent and said nothing about the
pillar. Both statements are in the plan; only one was where the work happens.
[[key-lifecycle-must-scale]] wants add/test/save/remove by one simple no-source-edit path, and a
paste-in table is a hand-edit. **The precedent below mitigates the risk of the hand-edit, not its
pillar cost.** Named successor, unchanged: phase B, first task after the refresher (§8.1).

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

- **`unsupported-shape` fails the provider that produced it, not the run** *(#61)*. What this task
  used to say: *"**`unsupported-shape === 0` — non-waivable.** A provider being down is a fact about
  the world; an unparseable shape is our own defect and fails the run."* **The second sentence is
  still true; the blast radius was wrong.** One provider's novel envelope discarded 43 successful
  listings and forced a re-authorized re-run of all 44 authenticated calls — on the single most
  expensive operation in this branch, and the one requiring explicit user authorization. The rule is
  now: record `unsupported-shape` **for that provider**, with the observed top-level keys (R8 already
  captures them), keep every other provider's result, and re-run **only** the providers that failed.
- **A partial or failed run RETAINS ITS CACHE, and retention is the default.** Stated explicitly
  because it is what makes the per-provider gate worth anything: a re-run after a shape failure must
  cost the failed providers, not 44 authenticated requests. A run that discards its own successes on
  one failure is a run-wide gate wearing different words.
- **The zero-shape ambition is not abandoned — it is un-asserted** *(#61)*. **No measurement supports
  it.** Nothing in this branch shows zero unsupported shapes is achievable across 44 providers: R9 is
  still migrating `listing` profiles when R10 starts, only 20 of 44 row-providers were ever probed on
  a `/models` path, and **every one of those probes was unauthenticated** (119 × 401). Compare **R13b
  in this same plan**, which sets its cap by a *measured* ceiling and writes the number and its date
  beside the constant — that is the standard a gate must meet here too. If a run-wide gate is
  genuinely wanted, it must be **evidenced first**, from this run's own measured shape-coverage
  number, and adopted as a follow-up rather than asserted ahead of the data it would gate.
- Coverage printed as `N of 44 eligible`, never "of 47", with `no-endpoint` excluded from the
  denominator and `testModel`-only / catalogue-only providers counted **separately** rather than
  folded into "covered".
- `tabiai` and `gorouter` produce a real outcome (both returned `200 data: []` in the corpus, so
  `empty` is the expected and correct answer — not a failure). **And neither is pruned by that
  outcome** — R11's candidate set is a union, not the discovered set (#58).
- Coverage below the floor is waivable with `--accept-coverage-delta`. `unsupported-shape` is not
  waivable **for the provider that produced it**, and does not gate the others.

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
full discovered set" — M10. The **discovery half of the union** comes from R10's cache, read through
the same `discovery` input R14 defines; state the source rather than implying one. The dependency
survives revision 7's union correction below: the catalogue and `testModel` halves need no cache, but
the discovery half still does, so R10 remains a hard predecessor.)*

`buildProviders` stops sizing `providers[].models` and `picker` from one array. Routing takes
**`union(discovery ids, catalogue ids, testModel)`** (admitted, sanitised, joined), the discovered
half read from R10's cache, **uncapped**; `picker` keeps a cap
under a **distinct renamed constant** `MAX_PICKER_MODELS_PER_PROVIDER`, **value 3, unchanged**, and
ranked by the **two terms that actually exist** — R3's `outputKind` guard, then the R3-repaired
free-first term, then id length. **No `localeCompare`** (A4, §1.2).

#### R11 is not #47's root-cause repair. Its justification is reach, and only reach (#74, OQ-6)

*(revision 10.)* **What the plan used to claim on this task's behalf**, at §1.2: *"widening the
recognized set is the fix, so D4 step 1 is not a workaround for #47 but its root-cause repair."*

R1 has run and falsified it. The substituting layer is **Claude Code's `env.ANTHROPIC_MODEL` taking
precedence over `settings.model`**, applied client-side before the request reaches CCR — not CCR's
`Router.builtInRules["claude-code"]`. **And the conditional is falsified, not merely the layer**: the
documented route substitutes only *"when the client has not selected a **recognized** model"*, yet the
pinned `anthropic/claude-haiku-4-5-20251001` **is** recognized and routable and was overridden anyway.
**An override that fires regardless of recognition cannot be stopped by widening the recognized set.**
R11 therefore could not be #47's root-cause repair under any implementation.

**This changes nothing about whether R11 ships.** It is justified on **reach** —
[[route-max-working-models]], pillar 1: ~1,501 rows resolve to `undefined` and do not route today, and
after R11 they route. That was always the pillar-1 case for step 1 and it is untouched. What is
withdrawn is the **#47/#48 justification** and the "root-cause repair" framing.

**Two things an executor must not do with this.** Do not treat #47 as closed by R11 — it is not, and
nothing in this branch fixes it. Do not widen R11's scope toward the real cause: the fix is a
disagreement between two `settings.json` fields keysync writes, out of scope here. Record: OQ-6
(`77fd735`), issue #74.

#### The candidate set is a union, and "the full discovered set" would have pruned live providers (#58)

**What this task used to say:** *"Routing takes the full discovered set (admitted, sanitised, joined)
from R10's cache, **uncapped**."* Fed literally into `buildProviders`, that is not a dim — it is
**removal from `Providers[]` entirely**, because the skip precedes the push *(read,
`keysync/keysync.mjs:558-564`)*:

```js
if (!models.length) {
  notes.push(`${reg.provider}: no testModel and no catalog entry — skipped`);
  continue;                       // <- precedes the out.push below
}
const name = reg.provider;
out.push({ name, provider: name, type, api_base_url: baseUrl, ... });
```

That branch is unreachable today **only** because `models` is seeded from `safeTestModel` and the
catalogue entries earlier in the same loop (`:523-556`), independently of any listing. A
discovered-set-only rule removes the seed and makes the branch reachable — for **four providers named
in this plan's own data**:

| provider | discovery outcome | source |
|---|---|---|
| `tabiai` | `empty` (HTTP **200**, `data: []`) | §4/R10 |
| `gorouter` | `empty` (HTTP **200**, `data: []`) | §4/R10 |
| `youcom` | `no-endpoint` (`listing: null`) | §4/R9 |
| `githubcopilot` | `no-endpoint` (`listing: null`) | §4/R9 |

**Only the first two can actually reach the skip** *(revision 8)*. This table is a **discovery**
table — those are the four discovery outcomes, correctly cited to §4/R9 and §4/R10. In **routing**,
`filterRegistry` (`keysync/keysync.mjs:31-37`) drops `youcom` and `githubcopilot` on
`protocol: "generic"` before `buildProviders` ever runs, as D6 records. They are listed here because
the discovered-set-only rule was argued from discovery data; the assertion that guards against the
prune names `tabiai` and `gorouter` only, and says why under **Verify** below.

**Two of them answer with HTTP 200.** A provider that responds and is then deleted from the config is
precisely what [[responding-provider-never-pruned]] forbids: a listing, auth or billing failure is
**state to surface**, never a reason to stop routing.

**It also contradicted the locked decision it claims to implement.** D3 §4.1: *"**testModel always
survives** regardless of the listing"*, and *"catalogue-only rows are kept, dimmed, and ranked last …
model absent → **dim, never prune**."* The union restores that, and makes routing agree with the
display path **by construction** — R14 already builds `union(discovery ids, catalogue ids, testModel)`
(§1.5a). **A provider whose discovery outcome is `empty`, `auth`, `no-endpoint` or `error` keeps its
catalogue and `testModel` rows and stays in `Providers[]`.**

**Why the byte-identical observable was not a guard against this.** The `{model → behavesAs}`
criterion below *would* detect the prune — a lost provider loses its picker rows and its
declarations. But the plan simultaneously handed an executor a **documented innocent explanation** for
exactly that delta: §1.1 said *"Discovery removes that accident"* of tabiai and gorouter, so a
reviewer watching those two vanish had a sanctioned reason to rebaseline **in good faith**. **A
detector whose failure has a blessed excuse is not a guard.** §1.1 is corrected (#58), and the
presence assertion in this task's observables is stated separately so the two can never again be
resolved in the wrong direction.

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

The routing set's per-entry capability comes from **R5's join**. `behavesAs` remains never-absent on
every picker row.

**The miss path is not one branch, and this task must not be written as if it were** *(revision 8,
#66)*. This sentence read *"`null` on miss → weak bucket"*, restating D3 §4.2's three-row table.
`bucketFor` (`keysync/keysync.mjs:234-241`) has **six** branches, and the one the short form hides is
the row that **joins, carries `limits.contextTokens`, and has no `capabilities.reasoning`**: there
context size is a **proxy** for unknown reasoning, and at `>= CTX_CAPABLE_MIN` (128000) it **promotes
the row to the capable target**. A true miss — no join at all — does reach the weak *target*, but by
way of the `unknown` bucket rather than the `weak` one (`BUCKET_TARGETS.unknown ===
BUCKET_TARGETS.weak`), and the two are separately countable on purpose. Amended D3 §4.2 carries the
completed six-row table; live footprint of the proxy branch is **3 of 83 rows**, all at the boundary
the source comment at `keysync/keysync.mjs:207-213` enumerates.

**Why this lands on R11 and not on the decisions doc alone.** R11 spends discovery's live
`capability` field, and **a listing that reports a context window but no reasoning flag is a common
shape** — so this branch governs a population far larger than 83 the moment discovery lands. R11
still changes **no** `BUCKET_TARGETS` value, no `ALLOWED_BEHAVES_AS` entry and not `CTX_CAPABLE_MIN`
(§0.1). The byte-identical `{model → behavesAs}` criterion below is what holds that line, and it
holds it only if the executor knows all six branches it has to reproduce.

**Verify:** `node keysync/run.mjs --dry`. Expected observables:

- **Every provider present in the pre-R11 build is present after it, with at least its `testModel`
  row** *(#58 — none of the four criteria below asserts this, and the widening is exactly where a
  provider can be lost)*. Assert **per-provider presence** in `built.providers`, never a total count:
  a count is satisfied by a provider gained elsewhere while another is dropped. Name the **two** at
  risk explicitly — **`tabiai` and `gorouter`**, both `protocol: "openai"` with a real `testModel`
  (`claude-opus-4-8`) and both answering `200` with `data: []` — and assert each by name, because
  those are the rows the `!models.length` skip at `keysync/keysync.mjs:558` claims. **Mutation
  check:** forcing a provider's discovery result to `[]` must leave it in `Providers[]` carrying its
  `testModel`, and reverting the candidate set from the union to the discovered set must make this
  assertion **fail**.
  - **`youcom` and `githubcopilot` are out of this observable's scope, deliberately** *(revision 8)*.
    `filterRegistry` (`keysync/keysync.mjs:31-37`, generic exclusion at `:36`) drops every
    `protocol: "generic"` row **before** `chooseKeys` and `buildProviders`, and the live vault gives
    both as `{"protocol":"generic","testModel":""}`. Neither is in `built.providers` before R11 or
    after it, so asserting their presence is **failing or vacuous** — never a guard. D6 already
    records this: *"`youcom` + `githubcopilot` (no HTTP surface, **already excluded by
    `filterRegistry`**)"*. Do not "helpfully" re-add them.
  - **What this criterion used to say, and why it was wrong** *(revision 8)*. It read *"Name the four
    at risk explicitly — `tabiai` and `gorouter` (`empty`), `youcom` and `githubcopilot`
    (`no-endpoint`)"*, which also put the plan in contradiction with D6. The four-provider list is
    true **of discovery** — R9 assigns `listing: null` → `no-endpoint` to `youcom` and
    `githubcopilot`, and §4's outcome table lists all four — and false **of routing**, which the two
    `generic` providers never reach. **A true statement about one stage was carried into an assertion
    about another.** The outcome table it came from is a discovery artifact and stands unchanged;
    only this routing assertion was wrong.
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
2. **Introduce provenance ranking** — `call-verified` > `config-asserted` > `listing-verified` >
   `catalogue-only`, then
   the existing `outputKind` → free-first → id-length terms *(moved here from R11, G2; no
   `localeCompare` — A4)*. **The `config-asserted` term is revision 6's** *(#59)*: the order was
   three-termed, and it is where "the new rung sits above `listing-verified`" is actually enforced
   rather than merely asserted in §2.3 — a ranker that omits the rung would sort the relay's four
   models and every vault `testModel` below a third-party listing row, which is #45. `null` ranks
   last, unchanged. This task is
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

**What this criterion does NOT target, stated plainly** *(#64)*. The acceptance criterion above is a
**byte and parse-time budget**. It is **not** a capability-declaration criterion: nothing in it asks
how many routing rows lack a `behavesAs`, and nothing in it forces the undeclared population down.
Quantity (3) is reported precisely so the tradeoff is visible — but reporting is not shrinking. §1.2
permits *"if the measurement justifies only 83, R13b lands 83"*, and that is a legitimate outcome of
this task, so **this task may complete correctly and leave §1.2's pillar-2 cost — ~3,700 rows
resolving through `lH()` to the maximal assumption set — unmitigated in full.** That is the honest
reading of the gate, and an executor should not infer a guarantee from the fact that the shrink has an
owner.

**And no task in this plan closes it if that happens.** D4 step 2's remaining half is a *surface*
question, not a declaration one (§8), and §8.1 names no successor for the declaration gap. **If the
measurement lands at or near 83, filing that successor is part of this task's output** — a named
follow-up, per §8.1's own rule that a deferral goes to a name rather than to nothing. This plan does
not otherwise defer it, and must not be read as having done so.

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

**Revision 11 — this task is the producer for the widened population, and those three sites are no
longer the whole of it.** Per §2.5(c), `refused[]` now means **withheld with a reason**, not
`admitId`-refused. The three `admitRemoteModels` sites above contribute **~0 of 1,588 rows** after R2
and remain correct as far as they go; the class that actually populates the list is the **~1,501
rows that are not routable because the provider is capped**, carrying the reason *"not in the routing
table: provider capped at 3 models"*. `buildFrom` is where both are known — it is the function that
decides which candidates become `models[]` — so it emits both into the same array, in the same
`{id, reason, removed}` shape. `removed` is `0` for a withheld-but-unsanitised row; the field means
"code points stripped", and nothing was stripped from an id that was simply not selected.

**The complementarity property is what makes the count in §2.5(a) meaningful and it must hold across
the widening:** every candidate ends up in exactly one of `models[]` or `refused[]`, never both and
never neither. That is a stronger statement than revision 10's and it is the one to assert.

**Observables for the widened list** *(revision 11)*:

- a provider capped at 3 with more candidates emits the surplus into `refused[]` with the **cap
  reason**, and `models.length + refused.length` equals the candidate count — the complementarity
  property stated directly;
- an id refused by `admitRemoteModels` still appears with its **own** reason, not the cap reason —
  the discriminator that fails if the widening flattens every reason to one string;
- a provider withholding nothing emits `refused: []`, not a missing key;
- **the reason is carried as data, not matched against a closed set** — assert that a reason string
  this task does not itself produce survives to the row unchanged, because R11 retires the cap reason
  and the feature must outlive it.

*(Revision 2, C2. Revision 1 had this task carry provenance without anything computing it — see
§1.5a.)* Two new inputs on `buildFrom`, both defaulted so every existing test keeps working:

- `discovery`, shaped like `catalog` (`{byProvider: Map}`), **defaulted to an empty Map**. Candidates
  become `union(discovery ids, catalogue ids, testModel)` — without this, a model that appears *only*
  in a live listing never becomes a row, which is exactly the `listing-verified` population.
- `provenanceOf(provider, id)`, **defaulted `() => null`**, mirroring `routableOf` /
  `makeRoutableOf` because that is the pattern this codebase already uses for a refresher-resolved
  value injected into a pure builder.

**The two config-literal assignments are `"config-asserted"`, never `"call-verified"`** *(revision
6, #59; decisions §4.1 amendment)*. Every prior revision had this task assign `"call-verified"` to
both the
vault `testModel` and the relay's four models — a top-rung label, on a ladder whose top rung is
defined as *"a real completion returned 200"*, written by a literal that nothing ever re-probes.
**This task must not emit the string `"call-verified"` at all.** That rung is reserved for a dated
probe result and has no producer wired in this branch (§2.3).

**Row membership is unchanged by this correction.** The vault `testModel` still survives regardless
of the listing, and every catalogue-only row is still kept; only the label on those rows moves one
rung. Nothing about the union changes.

#### #75 addition: routing modes and non-LLM services are not models, and this task must stop rendering them as models

*(Revision 10. Folded here because R14 owns the `capability` → `outputKind` precedence, which is the
same decision surface.)*

**The finding.** The catalogue carries rows that are not models, and every consumer treats them as
models:

- **`auto` exists under 8 providers with a 62× context spread** — `morph` at **32,000**, `kilo` at
  **2,000,000**. That spread is not a disagreement about one model. Each row describes **that
  provider's own pool**, so `ctx` is a property of a routing policy, not of anything that answers.
- **`search` appears under 16 providers with `ctx: null`** — DuckDuckGo, Firecrawl, Exa. Those are
  **services**, not chat models.
- **Four reach the live picker today:** `openrouter/auto`, `kilo/auto` (both `ctx: 2,000,000`),
  `orcarouter/auto`, `openrouter/router`.

**What this task must do.** Classify such a row as a **mode**, alongside the `outputKind` decision it
already makes:

- **Do not present pool properties as model facts.** `ctx` and capability **must not render as model
  values** on a mode row. A 2,000,000 window that describes a router's reach is a confident-wrong
  about whatever eventually answers, which is exactly what [[models-used-as-designed]] forbids where a
  value is not knowable.
- **A mode must never feed `bucketFor`.** Its `ctx` is not the answering model's window, so the
  context proxy branch (D3 §4.2, the `>= CTX_CAPABLE_MIN` promotion) would promote a row on a number
  that belongs to a pool. `kilo/auto` at 2,000,000 would classify **capable** on no evidence about
  any model.
- **Price stays visible when it is real.** Providers often offer their auto mode **free**, and
  `morph/auto` at **0.85 / 1.55** shows it can also be paid. Price is a fact about the mode itself —
  it is what the user is actually billed — so it renders. This is the one property that does not
  belong to the pool.
- **Rows stay selectable. Never prune.** [[responding-provider-never-pruned]]. `auto` is a legitimate
  thing to select; the defect is describing it wrongly, not offering it.

**No hand-maintained name list.** A literal `["auto", "search", "router", …]` is exactly the label
that goes stale the first time a provider invents a name, and the standing rule forbids a label that
cannot be kept fresh ([[uwpick-shows-latest-functional-state]]). Classify from **signals**:

| signal | availability |
|---|---|
| `ctx: null` alongside a text output declaration | today, from the bundle |
| a **modality union across a pool** — an entry declaring more output modalities than any single model serves | today, from the bundle |
| the **provider's own `capability` field** | once discovery lands; R8 keeps it as `capabilityRaw`, and this task already consumes `capability` for `outputKind` |

The third is the durable one and arrives on the same input this task already reads, which is why the
classification belongs here rather than in a later render task.

**Scope fence.** This changes **how a mode row is described**, never **whether it exists**, and it
touches no `BUCKET_TARGETS` value, no `ALLOWED_BEHAVES_AS` entry and not `CTX_CAPABLE_MIN` (§0.1) —
it keeps mode rows **out of** the classifier rather than reclassifying anything.

**Verify:** `node --test "test/catalog.test.mjs"`. Expected observables:
- a model present **only** in `discovery` becomes a row, with `provenance: "listing-verified"`;
- a model present only in the bundle becomes a row with `provenance: "catalogue-only"`;
- the vault `testModel` is `"config-asserted"` and **survives regardless of the listing** (D3 §4.1)
  — the survival half of this observable is unchanged from revision 3 and must stay asserted, so
  that the label correction cannot be mistaken for, or silently become, a prune;
- a relay (`anthropic`) model is `"config-asserted"`, not `null` and not `"call-verified"`;
- **no row produced by this task carries `"call-verified"`** over a fixture set that includes both
  a vault `testModel` and the relay — the observable that fails if either literal comes back;
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

**#75 observables** *(revision 10)*:

- a `ctx: null` row declaring text output (the `search` shape, 16 providers) classifies as a **mode**,
  and its `ctx` and capability cells render as **not-a-model-value**, not as `?` and not as a number;
- `kilo/auto` (`ctx: 2,000,000`) and `morph/auto` (`ctx: 32,000`) both classify as modes **from
  signals, not from the string `auto`** — assert with a fixture whose id is *not* a known mode name,
  so a hand-maintained list cannot satisfy this;
- **a mode row never reaches `bucketFor`** — assert directly, because the 2,000,000 value would
  otherwise promote it to the capable target through the D3 §4.2 proxy branch;
- **`morph/auto` keeps a visible price of 0.85 / 1.55**, and a free auto mode keeps its free badge —
  the discriminator that fails if price is suppressed along with the pool properties;
- **all four live picker rows survive**: `openrouter/auto`, `kilo/auto`, `orcarouter/auto`,
  `openrouter/router` are present and selectable after the change. **Mutation check:** a
  classification that prunes a mode row must fail this assertion.

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

**Schema 3 pins the rung vocabulary, and an observable must fail if it regresses to three**
*(revision 6, #59)*. This is the reason the ladder split ships in this branch rather than deferring
with the freshness work: schema 3 is where the vocabulary becomes persisted data, and a schema 3
written with the old three rungs would force phase B to migrate 3 → 4 or to carry two incompatible
meanings of `"call-verified"` in one schema. Assert the accepted set **as a set**, not by spot-checking
one value: every serialized `provenance` is one of
`{"call-verified", "config-asserted", "listing-verified", "catalogue-only", null}`, and
`"config-asserted"` is **present in the accepted set** — an assertion that fails if a later edit
drops the rung, collapses it back into `call-verified`, or renames it without updating the schema.
Pair it with the R14-side observable that no snapshot row carries `"call-verified"` from a config
literal, so the vocabulary is checked at both the producer and the persistence boundary.

**#51 addition:** the per-provider literal gains `refused`, on the **same 2 → 3 bump** — one
migration, not two. It carries the same `?? null` / explicit-array discipline as the rest: an
absent-vs-empty distinction here would make "nothing was refused" indistinguishable from "nobody
looked". Assert `Object.hasOwn(row, "refused")` on every serialized provider.

**Revision 11 — the field is unchanged, its contents widen, and the vocabulary assertion has to be
rewritten rather than dropped.** Per §2.5(c) and R14, `refused[]` now carries **withheld-with-a-reason**
rows — dominated by the ~1,501 capped-out rows — not `admitId` refusals alone. The `2 → 3` bump is
still one migration and the `Object.hasOwn` assertion still stands as written.

**What changes is how the reason is checked, and this is the part that is easy to get wrong.** The
provenance field beside it is asserted **as a closed set**, because its five values are the schema.
`reason` is **not** a closed set: R11 retires the cap reason and later work may add others, so an
accepted-set assertion over reasons would have to be edited on every such change and would fail for
the wrong cause. Assert the **shape and the floor** instead, so the observable still fails if the
vocabulary regresses:

- every element of `refused[]` has **all three** of `id`, `reason`, `removed`, with `reason` a
  **non-empty string** — the assertion that fails if a widened producer starts emitting bare ids, or
  `null`, or `""` for the classes that have no security code;
- `removed` is a **number** on every element, including the withheld-but-unsanitised rows where it is
  `0` — so "nothing was stripped" stays distinguishable from "nobody counted";
- **at least two distinct reason strings survive a round-trip** over a fixture holding both a capped
  row and an `admitId`-refused row — the observable that fails if serialization flattens the widened
  population back to a single reason, which is the specific regression the widening invites;
- `refused[]` round-trips **`[]` as `[]`**, never as absent and never as `null`.

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

*(Revision 11: **§2.6's consumer half is proposed as a separate task serial after this one**, on the
same two source files. It is not folded in here — it renders a keysync **run** record, not catalogue
data, and it reverses the decision recorded above `framesFor` in `menu/uwpick.mjs` that the picker reads no keysync state
file, which is a change a reviewer must be able to assess on its own. Whichever of the two lands
second serializes on `style.mjs` and `uwpick.mjs`.)*

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
- Each of the **five** provenance states renders a **distinct glyph** with `caps.colours === 0`, in
  both UNI and ASCII — `◆ ◈ ◇ · ␣` and `# = + . ␣`. *(Revision 6, #59: this said "four" before the
  ladder gained `config-asserted`. Pairwise-distinct across all five is the assertion, not
  distinct-from-blank; `healthDot`'s own failure mode was a predecessor returning the same glyph for
  ok, needs-$ and broken under a test titled as if it checked otherwise, and a four-way test left
  passing while a fifth state renders as one of the others would reproduce it exactly.)*
- **`call-verified` renders from a fixture even though nothing produces it in this branch** (§2.3).
  The rung is defined and unfed; the glyph test is what keeps it correct for the day it is wired,
  and dropping it because "no row can reach it" would delete the only check on the top of the
  ladder.
- **A relay row renders `◈`/`=`, not blank and not `◆`** — the #45 inversion guard, restated for the
  corrected rung.
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

**#51 addition — the persistent provider-level indicator (§2.5(a)).** ~~`W.refused = 3` plus a
one-column gap after `health`. The level-0 row **allocates 70 of 75**, so this lands at **74 with 1
spare** (G4/M12 — not the 68-of-75 revision 2 claimed).~~

**Revision 11 — no new column; the existing `W.count` cell carries both numbers.** Per §2.5(a), the
seven-column model-count cell renders `#MODELS/#WITHHELD` — `343/200` is exactly seven characters.
`W.refused` is **not** added and no gap is opened after `health`. **The level-0 row stays at its
current 70 of 75, with 5 spare**, so this task no longer consumes the level-0 headroom at all. The
header cell still derives from the same `W` constants as the row — `menu-layout`'s derived-offset
test asserts they agree rather than trusting it, which is the test that caught the previous
off-by-one — but it now **renames** one cell rather than adding one.

**#51 addition — the visible entry point (§2.5(b)).** The model level gains a **`WITHHELD LIST`
first row**, above the model rows, opening the same overlay ctrl+r opens. Suppressed entirely when
the provider withholds nothing. The wording is **`WITHHELD`, not `BLOCKED`** — §2.5(c) records why:
the population is dominated by capped-out rows, not hostile ids.

Extra observables *(revision 11)*:

- a provider withholding nothing renders the **bare model count** (`343`), not `343/0` and not a
  blank cell — the count itself is never suppressed, only the second half;
- a provider withholding rows renders **both numbers with the separator**;
- **counts that exceed seven columns render correct-or-visibly-abbreviated, never truncated** —
  measured, `sanitizeDisplay("1501/1501", 7)` returns `"1501/15"`, a plausible wrong pair rather than
  a visibly clipped one, so this must be asserted **on the rendered string** and not on width alone;
- the `WITHHELD LIST` row is **absent** on a provider withholding nothing and **present and focusable**
  on one that withholds;
- the level-0 frame still measures exactly 78 in both glyph sets.

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

**Revision 11 — a second door onto the same overlay, and the reducer does not grow to carry it.**
Per §2.5(b), the model level gains a visible **`WITHHELD LIST`** first row. Selecting it sets the
**same `state.refusals` field** the ctrl+r binding sets, so this is a second *entry point*, not a
second mechanism: no new nullable field, no new modal rule, no new projection. The four-part budget
above is unchanged, and that is the reason to build it this way rather than as its own view.

- **The row is not a model row and must not be treated as one.** It cannot be favourited, cannot be
  selected as a model, and does not enter the filter's match set — a filter that hides it while
  models remain is fine, but a filter that *matches* it as though it were a model id is a defect.
- **It is suppressed entirely when the provider withholds nothing**, which keeps ctrl+r's existing
  "no-op when the count is zero" rule and the row's presence saying the same thing. An overlay that
  cannot open and a row that opens it must never disagree.
- **Wording is `WITHHELD`, not `BLOCKED`** *(§2.5(c))*, and the overlay's own heading matches it.

**The overlay's contents widen with `refused[]`** — it now lists withheld rows of every class, each
with its reason, not `admitId` refusals alone. Two consequences for this task: the reason column must
render an **arbitrary reason string** rather than switch on a known set, and the overlay must **stay
correct when its dominant class empties** — R11 retires the cap reason that supplies ~1,501 of the
rows, and an overlay written around that one string breaks when it goes.

**`fatal` collisions never appear here** *(§2.5(c))*. They abort the run rather than hide a model, and
they belong in the run's output. This is stated in the task, not only in §2.5, because the overlay is
where someone would most plausibly add them.

**Revision 11 observables** *(in addition to those below)*:

- the `WITHHELD LIST` row opens the overlay on the provider being viewed, and the resulting
  `state.refusals` is **indistinguishable from** the one ctrl+r produces for the same provider — the
  assertion that fails if the two doors diverge into two mechanisms;
- the row is **absent** when the provider withholds nothing, and ctrl+r is a no-op on that same
  provider — asserted together, since they are one fact;
- the row is **not selectable as a model** and does not appear in the filter's match set;
- an overlay row carrying a reason string **the reducer does not know** renders that string
  unchanged — the observable that fails if the renderer switches on a closed vocabulary, and the one
  that keeps this working after R11.

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
- **The cap must disclose itself: render a `… N more` line** *(#60)*. Revision 5 cut the display
  10 → 5 with **no affordance at all**, so against today's live state — 10 stored, 9 rendering after
  the `known` filter — **4 entries vanish with nothing saying they exist**. They are not gone:
  `MAX_RECENTS = 10` is deliberately untouched (next bullet), so the storage is still there to be
  disclosed. That is a hiding action without disclosure **in the same ship that builds an entire
  drill-in overlay so refused ids are disclosed with per-id reasons** (#51) — two hiding actions, one
  ship, opposite treatment, and no stated reason for the asymmetry. Use the picker's existing "more"
  affordance if one exists; otherwise a single dimmed `… N more` line immediately below the pinned
  block, `N = (displayable recents) − 5`, **omitted entirely when `N === 0`**. **Display-side only:**
  no new persisted state, no probe, no cadence, no change to `MAX_RECENTS`, and no new key binding.
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
rows passes while the cap silently loses a slot. **And the disclosure gets both cases** *(#60)*: the
same 9-recent fixture renders **`… 4 more`**, while a **5-recent fixture renders no such line at
all** — the second half is what stops the affordance from being hardcoded on and reading `… 0 more`
in the common case.

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

**Detection.** **`unsupported-shape` is non-waivable for the provider that produced it** — coverage
may be waived with `--accept-coverage-delta`, a shape failure may not be waived for its own provider.
*(Revised, #61: this previously read "Zero `unsupported-shape` is a non-waivable gate on R10", i.e.
run-wide. The scenario this paragraph defends against is **one provider silently yielding zero
models**, and a per-provider gate detects that exactly as well — while a run-wide gate additionally
discarded 43 good listings on one novel envelope. The detection is unchanged; only the blast radius
is. See R10.)* The per-provider outcome table prints every provider, so a zero is visible per-name
rather than as a ratio. R8's offline fixture asserts the two-line header case directly.

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

**Correction, 2026-09-07 — R1 has run, and this scenario was aimed at the wrong layer** *(revision 10,
#74, OQ-6)*. **What this scenario used to rest on:** that the substituting layer is CCR's built-in
Claude Code route, so that widening the recognized set both causes and cures the repointing risk, and
that R1 would confirm it. **It is not CCR's layer.** The substitution is **Claude Code's
`env.ANTHROPIC_MODEL` taking precedence over `settings.model`**, resolved client-side; on all 25
measured rows `x-ccr-routed-model` equals `requestedModel` and CCR rewrote nothing. Three consequences
for this scenario, and the scenario **survives** all three:

- **Mechanism (b) is unchanged and remains the real risk.** Bare-id binding at width is a CCR
  `resolve()` stage-B4 property and has nothing to do with the substituting layer. R6 and R13 still
  bound it, and `hijackable` must still stay 0.
- **Mechanism (a) is unchanged.** `anchorModel`'s `built.picker[0].model` fallback is UW's own code
  (`run.mjs:891`); R13's byte-identical anchor assertion is untouched. It is also now **more**
  load-bearing, not less: the anchor keysync writes **is** `env.ANTHROPIC_MODEL`, which is the field
  measured to win over the user's pin. A silent anchor repoint therefore silently repoints the
  *effective* model for every main-agent request.
- **The compounding clause is corrected.** This scenario said the widening's risk *"compounds with
  #47's existing silent substitution."* It still compounds — but with an **unconditional client-side
  override**, not with a CCR route that widening could switch off. A remedy aimed at
  `Router.builtInRules["claude-code"]` would miss entirely, and none is proposed here.

**R1's role is discharged, with a different finding than predicted.** Its "which model answered"
method still works and is still what the detection check below uses; see OQ-6 (`77fd735`) for the
measured record.

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

- ~~**#48 is materially reduced by R11, as a side effect.**~~ **WITHDRAWN 2026-09-07** *(revision 10,
  #74, OQ-6)*. **What this bullet used to say:** *"#48 is materially reduced by R11, as a side effect.
  ~1,501 rows currently resolve to `undefined` and fall through to a silent substitution; widening
  routing removes most of those dead selections. #48's remaining half — the picker not saying anything
  at selection time — is untouched."* It falls with §1.2's root-cause claim, on which it depended. R1
  measured the substituting layer as **Claude Code's `env.ANTHROPIC_MODEL` winning over
  `settings.model`**, client-side, **unconditionally** — the pinned
  `anthropic/claude-haiku-4-5-20251001` is recognized and routable and was overridden regardless. So
  widening the routable set does not reduce the substitution at all, and R11 has **no measured effect
  on #48**. What remains true and is retained: ~1,501 rows resolve to `undefined` today and will route
  after R11. That is **reach**, booked under pillar 1 — not an #48 reduction.
- **#3's 95%-dimmed ratio inverts.** `routable: false` today covers ~1,501 of 1,588 rows; after R11
  most become routable, so the dim stops being the page and starts being exceptional again. **That
  changes what the picker looks like more than any render task in Ship E**, and it happens in Ship D
  where no render observable is watching. R16's rendering judgements should be made against a
  post-R11 snapshot, not today's.
| **Refresh cadence** (#17, #14, and the cadence half of #59) | D6 puts it in phase B; unblocker is a scheduling decision under F8. **Deferral confirmed, with its mitigations named** *(revision 6)*: `refresh/cli.mjs` is manual-invocation only, so `listing-verified` means "as of the last refresh" and the ladder has no clock. Two things make that disclosed rather than hidden staleness — the `discovered <date>` header stamp (R15's two-case observable exists so a permanently-null stamp cannot pass) and the user's stated phase-B plan of a single manual command refreshing listings, bundle and id matching together. The budget tolerates old-and-dated and forbids wrong-and-unmarked; see §2.4, which previously answered only the budget's cost clause and now answers its cadence clause too. **This mitigation does not cover the rung split** — a stamp cannot date a label that was never discovered, which is why that half shipped instead |
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

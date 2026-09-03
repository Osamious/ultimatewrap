# Phase 7 — Subagent model selection across providers

**Status: future work. Not planned, not scheduled, not estimated.** This file records the
goal, what is already verified about the mechanism, what is still unknown, and the design
questions that must be answered before a plan can be written. It is deliberately a
question document rather than a task list.

Raised 2026-09-03, during Phase 6 execution, from the question: *"I'm on an Opus main
agent and I want to summon a GPT-5.6-luna subagent — is that possible?"*

---

## The goal

Full support for spawning subagents on models that are not Anthropic's, including models
from a different provider than the one the main agent is running on. A session should be
able to run Opus on the main thread, a frontier non-Anthropic model for one kind of work,
and a cheap or free model for high-volume subagent work — concurrently, deliberately, and
visibly.

Phase 6 delivers model switching for the *main* agent. It does nothing for subagents
beyond what falls out of Claude Code's existing tier system. In a multi-agent workflow —
which is how this project itself is being built — subagents are the majority of traffic,
so this is where both the capability and the cost live.

---

## What is already true, verified

These are established facts about the current system, not assumptions. They constrain
every option below.

**Six tier aliases, written by UW.** `keysync/run.mjs:453-458` sets `model`, `opusModel`,
`sonnetModel`, `haikuModel`, `smallFastModel` and `fableModel` on CCR's `claude-code`
profile. With the relay up they point at `anthropic/…` ids; with it down, all six collapse
onto a single `anchorModel`. All six are set deliberately: CCR clears every model-alias
env var on each apply and repopulates only what the profile sets, and setting just `model`
was observed to leave background and small-fast traffic resolving to an unrecognised
`orcarouter/auto`.

**The tier names are pointers, not models.** Whatever a tier points at is what that tier's
traffic reaches. This is the mechanism every option here builds on.

**Claude Code's spawn call takes a tier, not a model.** The Agent tool's `model` parameter
is an enum — `sonnet`, `opus`, `haiku`, `fable`. Agent definition files on this machine all
use the same vocabulary (`model: sonnet`, `model: haiku`).

**Precedence for a subagent's model** is: explicit `model` on the spawn call → the agent
definition's frontmatter → inherit the parent's default.

**CCR resolution stages that matter here.** A namespaced `provider/model` selector matches
at stage 2, exactly and deterministically. Virtual models (`virtualModelProfiles`) match at
stage 3, ahead of any provider. Bare names fall to stages 4–5, which bind only when exactly
one provider lists the name and abort when more than one does.

**Anthropic-shaped tier values are namespaced today**, so subagent traffic never touches
bare-name matching. That is why the S1/S2 hijack surface does not affect subagents.

**Claude Code's payload is large.** Every request carries a full system prompt plus all
tool definitions. `ANCHOR_PREFERENCE` exists in this codebase because small models reject
that payload outright. Any candidate for subagent work must be verified against the real
payload, not against a toy prompt.

**`behavesAs` is a client-side prompt profile.** Every row carries
`behavesAs: "claude-sonnet-4-6"` (`keysync.mjs:120,256`). A non-Anthropic subagent is
therefore prompted as though it were Claude unless something changes that.

---

## What works today, without any new code

**Tier repointing.** Point `fableModel` at `<provider>/<model>` and spawn with
`model: "fable"`. The subagent routes to that model while the main thread stays on Opus.

This genuinely works, and it is the honest answer to "can I do this now". Its limits are
what motivate Phase 7:

- **Four addressable slots.** `opus`, `sonnet`, `haiku`, `fable` are reachable from a spawn
  call; `model` is the session default and `smallFastModel` is internal.
- **Global, not per-spawn.** Every `fable` subagent goes to the same place until the
  mapping changes. There is no way to say "these three on Claude, that one on GPT" within
  a single session.
- **Semantically wrong.** The tier names mean capability levels. Overloading `fable` to
  mean "the GPT one" is a pun that every future reader has to decode.

---

## Unknowns that must be settled before designing

None of these should be guessed. Each is answerable in minutes and each changes the shape
of the solution.

1. **Does Claude Code's agent frontmatter accept an arbitrary model string**, or only a
   tier name? If arbitrary strings are accepted, per-agent provider pinning becomes trivial
   and most of this phase collapses to configuration. If not, everything must route through
   the tier vocabulary.
2. **What selector actually routes to a virtual model?** CCR force-prefixes exact aliases
   as `` `Fusion/${alias}` `` unless they already begin `fusion/` (`Sd()`, ~offset 875300),
   and `gatewayModels` is keyed from that output with stage 3 looking up there. So an alias
   declared `uw/gpt` may only be reachable as `Fusion/uw/gpt`. This is already recorded as
   an open question against `UW_ALIAS` in the Phase 6 plan.
3. **Tool-use fidelity through CCR's protocol translation**, per provider family. Plain
   text survives translation well; multi-turn tool calling is where it frays. A subagent
   that cannot reliably call tools is not a subagent. This must be measured per candidate
   model against Claude Code's real payload, not assumed from a chat completion.
4. **Does Claude Code send the tier's env-var value verbatim as the request model**, or
   resolve it further first? Determines whether a namespaced value survives to CCR intact.
5. **What does Claude Code do when a subagent's model errors or returns a malformed tool
   call?** Retry, fail the subagent, or fail the parent turn — this decides how much
   isolation a misbehaving foreign model needs.

---

## The design questions

These are the substance of the phase. They are open; the notes under each are starting
positions, not decisions.

### Should a subagent inherit the main agent's model by default?

*Starting position: yes, inherit — but only for subagents that do not name a tier.*

Inheriting is the least surprising default and matches Claude Code's current behaviour. But
it interacts badly with cost: if the main thread is on Opus, every inheriting subagent is
also on Opus, which is how a research fan-out becomes expensive without anyone choosing
that. The counter-argument is that a subagent doing real work needs real capability, and
silently downgrading it produces worse results that are harder to attribute.

Worth considering: inherit the *provider* but not the *tier*, so switching to a cheap
provider moves the whole session's economics without changing the capability shape.

### Does the user choose a subagent's model, or is it automatic?

Three positions, and the answer may differ per surface:

- **Explicit only.** The user or the agent definition names the model. Predictable, no
  surprises, and every cost is chosen. Costs: verbosity, and the user must know which
  models can handle tool calls.
- **Automatic by task class.** UW maps kinds of work to model classes — cheap for
  mechanical search, frontier for architecture and review. Attractive, and it is what a
  cost-conscious operator would do by hand anyway. Risk: an automatic downgrade on work
  that needed capability is nearly invisible, and this project has repeatedly shown that
  the defects that survive are the ones with no visible symptom.
- **Suggested, confirmed once.** UW proposes a mapping; the user accepts or edits it; it
  then applies silently until changed. Probably the right shape, but it needs a place to
  live and a way to review it.

### How much control should the user get?

The spectrum, from least to most:

1. A default tier mapping the user can edit in one place.
2. Per-agent-definition pinning — `document-specialist` always on a cheap model,
   `architect` always on a frontier one.
3. Per-spawn override at call time.
4. Per-task-class automatic routing with an override.
5. A session-scoped "budget mode" that repoints several tiers at once.

More control is not automatically better here. Every additional dial is another thing that
can be set wrong and another thing whose current value the user has to remember.

### Where does the user express any of this?

Candidate surfaces, not exclusive:

- **The picker**, extended to a third level or a second mode: choose a model *for a tier*
  rather than for the session. Natural home, since the picker already knows every provider
  and model with pricing, badges and provenance.
- **Agent definition frontmatter**, if unknown 1 resolves favourably.
- **A settings file** UW owns, mapping tiers or task classes to `provider/model`.
- **A slash command** for one-off overrides.

### How does the user see what actually happened?

Non-negotiable in some form. A session where subagents silently ran on a different model
than the user believes is worse than one where they cannot change it at all. Minimum: the
model each subagent ran on is visible after the fact. Better: visible at spawn time.

The HUD is the obvious surface, and `hud-shim.mjs` already exists.

### What happens when a foreign model cannot do the job?

Failure modes to design for, distinctly:

- Rejects the payload outright — the `ANCHOR_PREFERENCE` case.
- Accepts it but produces malformed tool calls.
- Works, but degrades quietly on long multi-turn work.

The third is the dangerous one, and it is the same species as every defect Phase 6 spent
its review rounds on: no runtime symptom. Some form of verification-before-trust is needed
— the provenance model from Phase 6 (`call-verified` / `listing-verified` /
`catalogue-only`) is the obvious precedent, extended to "verified to handle Claude Code's
payload and tool protocol".

### What about cost?

The strongest single argument for this phase. In a workflow like the one that built Phase 6
— a planner, two reviewers, an executor, several explorers — subagents dominate token
spend. Being able to run mechanical work on a free provider while keeping the main thread
frontier is the highest-value lever UW can offer, and the machinery for it already exists.

Any design should be able to answer: what did this session cost, and what would it have
cost under a different mapping.

---

## Constraints inherited from Phase 6

- The user's three standing rules apply: never drop a provider for missing catalogue data
  or stale metadata; resellers are first-class; discovery must cover every provider call
  shape.
- Anything a subagent routes to must be a namespaced `provider/model`, so it resolves at
  CCR stage 2 and never touches bare-name matching. Do not solve this phase in a way that
  puts subagent traffic on the bare path.
- `~/.llmkeys/providers.json` is hand-maintained and never machine-written. Any per-model
  metadata this phase needs follows the `grantCadence` and `listing` precedent: a
  documented prose migration, plus a test that fails when the human step is skipped.
- Coupling to Claude Code stays inside `cc-contract.mjs`, and to CCR inside
  `ccr-client.mjs`.

---

## Related items already parked

- `BACKLOG.md` item 1 — the relay bare-alias mapping (Task A5.2).
- `BACKLOG.md` item 2 — narrowing the collision guard's predicate before Task B6.
- The `UW_ALIAS` / `Fusion/` open question, recorded in the Phase 6 plan. **Unknown 2 above
  is the same question**, and settling it serves both.

---

## First step, when this is picked up

Settle unknowns 1 and 2 before anything else, because together they decide whether this is
a configuration phase or an architecture phase. Then measure unknown 3 against two or three
candidate models, because a subagent that cannot call tools reliably makes every other
question moot.

# UltimateWrap — parked items

Items deliberately deferred, with enough detail to act on without re-deriving them.
Parked 2026-09-03 by the user's decision. Neither blocks Phase A or Phase B execution
up to Task B6.

---

## 1. Task A5.2 — teach the OAuth relay the four bare aliases

**Status:** parked. Written into the plan as Task A5.2 and fully specified there.
**Blocked on:** the user being ready for a relay restart. Not a technical blocker.
**Touches:** `C:/Users/osami/.local/bin/anthropic-oauth-relay.mjs` — outside the repository.

### What it does

Make the relay substitute the current full Anthropic id when a request arrives for bare
`opus`, `sonnet`, `haiku` or `fable`. Today it forwards the request body unmodified
(`:246` handles `GET /v1/models`, `:155` attaches the OAuth bearer and forwards as-is;
verified 2026-09-03), so `{"model":"opus"}` reaches Anthropic verbatim and is rejected.

### Why it matters

Claude Code accepts bare model names. The relay advertises four full ids and claims none
of the bare ones, so bare `opus` is an unowned name. CCR's `resolve()` binds a bare name
when **exactly one** provider lists it (`providerModelMatches`, `dist/main/cli.js`
~offset 998924 — verified). If any provider in the vault begins publishing `opus`, it
becomes the sole owner and CCR routes the full system prompt, tool definitions and file
contents to that host.

The S1 guard does not cover this case: `checkBareCollisions` keys on the relay being
**absent**, and this is the case where it is present. Relay co-ownership is the defence —
with two owners, `resolve()` returns `undefined` and nothing binds. Ambiguity is the fix.

### Why it is two halves, in this order

Advertising the aliases before the relay can serve them is worse than doing nothing.
Today a bare `opus` finds zero stage-4 matches and fails cleanly. After advertising, it
would bind to the relay and then 404 upstream — a clean failure made to look like a
successful route. Task A5.1's Step 3b is therefore gated on `aliasesOk`, which is false
until this lands, so keysync keeps writing today's four ids and no dead row is ever
written. The two halves may land in either order because the gate is enforced at runtime.

### Recommended implementation

Resolve aliases from the relay's own `/v1/models` response (it already proxies that
endpoint with the bearer), with a small static table as cold-start and degraded-path
fallback. The static table cannot be eliminated either way — cold start, unreachable
upstream and malformed responses all need one — so the only question is whether it is the
primary path or the backstop, and making it the backstop bounds how stale it can get.
A hard-coded pin would go stale exactly the way the `providers.json` `testModel` values
did, which is the failure that started this whole line of work.

Constraints already specified in the plan: exact-match substitution only, never prefix or
substring; word-boundary filtering reusing `RESERVED`'s discipline so `opus` matches
`claude-3-opus-20240229` but never `opusculum`; sort by `created_at` descending without
assuming the response is ordered; one-hour lazy cache; a 4xx naming the alias; and never
forward a bare alias upstream, stated as unreachable-by-fallthrough.

### Risk, and how to contain it

This is the only work in Phase 6 touching a file outside `~/.uw`, and it is the process
that keeps Claude reachable. A bad edit costs Claude access until reverted. Before
touching it: health-check the relay, take a timestamped backup, edit, restart, verify.
The file already has a `.bak-preharden` sibling, so it has been modified deliberately
before.

### Risk of continuing to defer

Latent rather than active. The current vault has no provider publishing a bare Claude
alias — the only collision today is `claude-opus-4-8`, co-owned by `gorouter` and
`tabiai`, which lands in `shadowed` and is therefore non-fatal. The exposure appears if
any provider adds a bare Claude alias to its listing, which happens without notice.

---

## 2. Narrow the collision guard's predicate before Task B6

**Status:** parked, but has a deadline — it must be settled **before B6 lands**, not during.
**Blocked on:** nothing. It can be done at any time, and item 1 makes it nearly free.

### The problem

`checkBareCollisions` currently fires on any id matching `RESERVED`
(`claude|opus|sonnet|haiku|fable` plus a boundary). The live probe of 2026-09-03 found
that `tabiai` and `gorouter` both serve `claude-opus-5-thinking`, and the relay does not.

It almost certainly *cannot*: Anthropic publishes no such model id — extended thinking is
a request parameter, not a separate model — so `claude-opus-5-thinking` is the resellers'
own naming.

Today this is harmless because both providers stand on `testModel` alone, so the id never
reaches `Providers[].models`. **Once Task B6's discovery populates their catalogues, the
id becomes sole-owned by non-relay providers and the guard goes fatal on every real run.**
The user's only options at that point would be a permanently failing keysync or
permanently passing `--allow-bare-claude-names`, which switches the guard off entirely.

### Why narrowing is correct, not a workaround

The guard exists because Claude Code sends **bare** names that CCR might bind to the wrong
host. Claude Code only ever sends names Anthropic publishes. A reseller-only variant
cannot be a hijack target, because nothing would ever request it unnamespaced. Firing on
it is a false positive by construction.

So the predicate should be "ids Anthropic actually publishes", not "any string matching
`RESERVED`". Do **not** resolve this by widening the opt-out.

### Why it pairs with item 1

Both need the same thing: an authoritative list of Anthropic's real model ids. Item 1
needs it to know what `opus` maps to; this needs it to know which names are plausible bare
targets. The authoritative, self-updating source is the same — the relay's `/v1/models`,
which forwards to Anthropic.

Doing item 1 first makes this one nearly free: the resolution logic it builds is exactly
the predicate this guard wants. Doing them in the other order means building the list
twice, and a hand-maintained second copy would go stale the same way `testModel` did.

---

## Related open question, already recorded in the plan

`UW_ALIAS` guards `/^uw\//i`, but CCR force-prefixes exact aliases as `Fusion/<alias>`
(`Sd()`, ~offset 875300) and keys `gatewayModels` from that output, with stage 3 looking
up there. So an alias declared `uw/fast` routes **only** as `Fusion/uw/fast`, and the
guard protects a namespace nothing currently routes on. Both options — declare aliases so
they surface as `Fusion/uw/…` and guard that shape, or use `virtualModelProfiles` and
confirm which stage those match at — are recorded at the `UW_ALIAS` definition in the
plan, with an explicit prohibition on guessing between them. Not urgent; nothing depends
on it yet.

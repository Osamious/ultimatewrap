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

### Measured evidence for the deadline (code review, 2026-09-03)

A code review of the committed A-i work verified the following against the live vault:

- `tabiai` and `gorouter` are **absent from the bundled catalogue entirely**. Their built
  models today are therefore one stale `testModel` each, and that is the **only** reason
  `claude-opus-4-8` currently has exactly two owners and lands in `shadowed` rather than
  `hijackable`.
- Consequently the guard is non-fatal today by accident of missing data, not by design.
  Losing either provider — key expiry, a `testModel` edit, `--verified-only` — makes the
  id sole-owned and fatal immediately. Confirmed by simulation.
- When B6 populates their catalogues, **every Claude id served by only one of them becomes
  sole-owned**, and `checkBareCollisions` exits 1 on the main write path. `claude-opus-5-thinking`
  is the likely first instance.

A second, related defect must be fixed in the same pass: the fatal message's primary
remedy is unachievable for the very id that will fire it. It says to start the Anthropic
relay so it co-owns the id, but the relay serves `claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001` and `claude-fable-5-1` — never `claude-opus-4-8`. Only
`--allow-bare-claude-names` would work. Gate the relay remedy on
`ANTHROPIC_RELAY.routing.includes(h.id)` so the message only offers it when it is achievable.

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

## Pending fix pass — code review of commits `437f3e6`..`c10e6ee`

Queued to run after Tasks A6–A10 land, so the writes are sequenced rather than raced.
Every finding below was verified by executing a mutant or checking live data, not by
reading. None is live breakage today; all are latent or coverage gaps.

**High**

1. `menu/ccr-client.mjs:89` — the RPC drift check cannot report a missing method.
   `methods[m] = r !== undefined`, but `rpc()` returns `null` on every failure path
   (`:99` no service, `:116` catch, `:105` `body?.value ?? null`). A throwing `fetchImpl`
   and an unknown-method error both yield `null`, so the check reads `true` either way and
   `uw doctor` reports all three methods present with CCR dead. Fix: return `undefined`
   from the failure paths, keeping `?? null` only for a genuine null result — or return
   `{ok, value}`.
2. `keysync/run.mjs:63` — the guard's production input shape is untested. Every S1 test
   builds `{id}` objects via `P()`; `buildProviders` and the relay unshift both emit
   `models` as `string[]`. Narrowing `String(m?.id ?? m ?? "")` to `String(m.id ?? "")`
   yields `["",""]` on production data — the guard becomes a silent no-op with F1
   unguarded — and all 91 tests still pass. Fix: one case with
   `[{name:"tabiai", models:["claude-opus-5"]}]`.
3. `keysync/run.mjs:101` — the fatal message's primary remedy is unachievable for the id
   that will fire it. See the deadline evidence above.

**Medium**

4. `menu/catalog.mjs:56-58` — provider-matched pricing is untested for the case it exists
   to handle. `test/fixtures/catalog.json` has no entry with more than one offer and none
   whose `offers[].provider` differs from the row's. The live catalogue has 973 entries
   with ≥2 offers, **792** where `offers[0].provider !== row.provider` (e.g.
   `alibaba/qwen-3-14b`, whose first offer is Vercel's and whose correct answer is `null`).
   Reverting `priceOf` to `offers[0]` — the exact defect the comment at `:36` records —
   passes 91/91 and badges those rows with another host's price. Fix: a fixture entry with
   two foreign offers, asserting `priceOf(e, "acme") === null`.
5. `menu/catalog.mjs:16` — `writeAtomic` is imported and never used; `writeSlot` (`:228`)
   uses plain `fs.writeFileSync`, so ctrl+c mid-write truncates `slot.json` and `readSlot`
   swallows it to `""`. Fix: `writeSlot` → `writeAtomic`.

**Low**

6. `menu/atomic.mjs:13-18` — on a write or fsync throw the previous file is correctly
   intact, but `${file}.tmp-${pid}` is left behind. Add `catch { fs.rmSync(tmp, {force:true}); throw; }`.
7. `keysync/run.mjs:59` — owner counting ignores `enabled`, which is CCR's own gate, so a
   disabled co-owner reads as safe while CCR sees one match. Latent (always `true` today).
   `if (p.enabled === false) continue;`.
8. `test/denylist.test.mjs:340` — title claims the routing list holds eight ids; the body
   checks neither the length nor that `FULL` is a subset of `routing`.
9. `menu/catalog.mjs:164` — `admitRemoteModels`' `console.warn` fires inside the picker's
   build path, into the alternate screen mid-frame. Zero rejections across all 4,298 live
   ids today, so latent — but **goes live with B6**, since discovery returns raw provider
   strings rather than today's uniformly clean bundle.
10. `test/menu-layout.test.mjs:21` — the spike-reference guard omits `catalog.mjs`, the one
    file whose contents A2 changed. Clean today, so a coverage gap rather than a bug. Fix:
    add `"catalog.mjs"` to the loop.

**Noted, not asserted:** `spike/` still holds 10 tracked files plus a 45 MB untracked
`cc_strings.txt`. Task A2 only claimed the picker spike, so this may be deliberate.

**Assessed sound, explicitly:** `menu/sanitize.mjs` and `menu/denylist.mjs` — no findings
at any severity. `admitId` accepts 4,298 of 4,298 live catalogue ids, so it drops no
provider and the `@`-scope widening closed the last rule-1 exposure.

## Forward note for whoever writes Task B10

Task A5's text says the refresher bakes `routable` into snapshot rows, but A8's
`buildSnapshot` enumerates eight model fields and `routable` is **not** among them — and
A8 ships a test asserting exactly those eight. If B10 writes routability through
`buildSnapshot` as it stands, the field is silently dropped and the routability column
renders empty, which is the round-2 defect returning by a different route.

Not a defect in A8 as specified, so it was not changed during execution. Resolve it in
B10 by extending both the field list and that test together, and confirm the picker
actually reads the field it is given.

## Phase 7 — subagent model selection across providers

Raised 2026-09-03. Written up in full in `phase7-subagent-models.md`: full support for
spawning subagents on non-Anthropic models, or on a different provider than the main agent.

Not planned, not scheduled. That file records the verified mechanism, five unknowns that
must be settled before designing, and the open design questions — default inheritance,
explicit versus automatic selection, how much control to expose, which surface expresses
it, how the user sees what actually ran, and what happens when a foreign model cannot hold
up its end.

Two connections to the items above. **Unknown 2 in that file is the same `Fusion/` prefix
question already recorded against `UW_ALIAS`** in the Phase 6 plan, so settling it serves
both. And the cost argument is the strongest case for the phase: in a multi-agent workflow
subagents dominate token spend, and the machinery to route them elsewhere already exists.

Works today without new code, as a stopgap: repoint `fableModel` at `<provider>/<model>`
and spawn with `model: "fable"`. Limited to four addressable tier slots, global rather than
per-spawn, and semantically a pun.

## Related open question, already recorded in the plan

`UW_ALIAS` guards `/^uw\//i`, but CCR force-prefixes exact aliases as `Fusion/<alias>`
(`Sd()`, ~offset 875300) and keys `gatewayModels` from that output, with stage 3 looking
up there. So an alias declared `uw/fast` routes **only** as `Fusion/uw/fast`, and the
guard protects a namespace nothing currently routes on. Both options — declare aliases so
they surface as `Fusion/uw/…` and guard that shape, or use `virtualModelProfiles` and
confirm which stage those match at — are recorded at the `UW_ALIAS` definition in the
plan, with an explicit prohibition on guessing between them. Not urgent; nothing depends
on it yet.

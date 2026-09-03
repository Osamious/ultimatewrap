# Phase 6 — reseller-safe discovery: design

Design document, 2026-09-03. Not a plan. A planner folds this into
`plans/phase6-menu-and-catalogue.md`; an executor implements it.

Written to a file rather than sent inline because the report kept truncating in
transit. Authored with the editor tool, not a shell heredoc — heredocs in this
project strip a backslash level even with a quoted delimiter and have already
produced five unparseable fenced blocks. This document contains **no fenced
JavaScript** for the same reason; every code reference is an inline span, so
there is nothing here that `node --check` would have to clear.

## The three standing rules this design serves

1. **Never drop a provider** because CCR lacks it, its bundled catalogue lacks
   it, or the vault's `testModel` is stale or rejected.
2. **Resellers are first-class.** Any provider with a working endpoint is
   supported, including Claude resellers. The defence moves from refusing a name
   to preventing *silent misrouting*.
3. **Discovery is exhaustive across every provider call shape**, so no provider
   silently yields zero models.

Rule 2 invalidates Task A5.1 as built. A5.1 is implemented but uncommitted, so
it is revised, not unpicked.

## Verified versus inherited

Verified directly in this pass, by reading the files:

- `keysync/keysync.mjs:168-240` — `buildProviders` is synchronous, pure over its
  injected inputs, and makes no network call. `testModel` leads (`:183-192`);
  catalogue extras append (`:193-205`); a provider with neither is skipped
  (`:206-209`).
- `menu/denylist.mjs` — `RESERVED`, `UW_ALIAS`, `isReserved`, and
  `admitRemoteModels` with its `trusted = "anthropic"` exemption.
- `keysync/run.mjs:98-120` — the relay liveness check and `anthropicOn`.
- `keysync/run.mjs:163-186` — the `byBare` / `claudeish` / `hijackable` /
  `shadowed` guard, currently `console.warn` only.
- `keysync/keysync.mjs:142` — `ANTHROPIC_RELAY.models` holds four full ids and
  no bare aliases.
- `keysync/key-health.mjs:41` — `headersFor` already splits `headersTemplate` on
  newlines and substitutes `{key}` per line. Three sibling scripts carry the
  same function.
- CCR `dist/main/cli.js` at offset 875300 — `Sd()`. See the appendix.

Taken from the evidence supplied with the brief and **not** re-derived: the
Maestro mechanism and its 41/47 coverage; CCR `resolve()` stages 4-5 semantics;
the S1/S2/S3 findings; report 01's per-provider table and its `notes` quotations;
report 12's measurement that catalogue-first dropped the live pass rate to 4/44.

Explicitly **not** verified, flagged again in the appendix: `providerModelMatches`
(approx. offset 1000600-1000800), and whether the local Anthropic relay maps the
bare aliases `opus` / `sonnet` / `haiku` / `fable`.

---

## 1. Discovery: profile-driven, not endpoint-assumed

`providers.json` has no `modelsEndpoint`, `listPath`, `apiVersion` or envelope
field — report 01's schema census confirms it. Discovery therefore needs three
new **optional** profile keys, with cluster-A defaults so that 41 of 47 entries
need no edit at all:

```text
listing: {
  url:      "/models"                       leading "/"  -> baseUrl + path
                                            "https://"   -> absolute override
  envelope: ["data", "models", "result"]    first key present that is an array
  idField:  ["id", "name"]                  first key present on an entry
  method:   "GET"
}

listing: null                               EXPLICIT: no listing endpoint exists
```

Omitting `listing` entirely means "cluster A defaults". `listing: null` is a
positive assertion that the provider has no listing endpoint, and is not the
same thing as a missing key. That distinction is what keeps a forgotten entry
from being silently reported as covered.

### Auth is already solved

`key-health.mjs:41` splits `headersTemplate` on newlines and substitutes `{key}`
into each line. That one function covers **cluster D** (agentrouter's three
mandatory WAF headers) and **cluster E** (`x-api-key` + `anthropic-version`,
`X-API-Key`) with zero per-provider code. Lift it into `refresh/discover.mjs` as
`headersFor(profile, key)`. Do not reimplement it — a parser that reads only the
first line of `headersTemplate` silently 401s on agentrouter, which is precisely
the failure mode rule 3 forbids.

### The six exceptions, concretely

| provider | resolution |
|---|---|
| **cloudflare** | `listing.url` is an absolute override, derived by stripping the trailing `/v1` from `baseUrl`: `https://api.cloudflare.com/client/v4/accounts/{acctId}/ai/models/search?task=Text%20Generation`. `envelope: ["result"]`, `idField: ["name", "id"]`. **Unverified:** I did not probe Cloudflare, so the entry key is unconfirmed — report 01 records the `{result: [...]}` envelope but not the per-entry id field. `idField` is a *list* precisely so the first live probe settles it as data, not as a code change. |
| **agentrouter** | **Not an exception.** The multi-line `headersTemplate` parse handles its three WAF headers. No profile edit needed. |
| **alibaba** | **Not an exception for discovery.** Report 01 records `{base}/models` returning 200 against the per-workspace domain already stored in the vault. It is non-portable, not undiscoverable. |
| **youcom** | `listing: null`. Protocol `generic`, so `filterRegistry` (`keysync.mjs:30-36`) already drops it before discovery runs. |
| **githubcopilot** | `listing: null`, empty `baseUrl`, protocol `generic` — same filter drops it. Recording `listing: null` anyway makes its exclusion auditable rather than incidental. |
| **anthropic** | Never discovered. The relay's model list is fixed and owned by us. |

Two entries also want a single probe rather than a design decision: **xai**, a
plain cluster-A entry that is nonetheless absent from `~/.maestro/model_cache.json`
with no note explaining why; and **commandcode**, whose `notes` say `GET /models`
while its `baseUrl` ends `/provider/v1`. Both are unknowns, not exceptions, and
must be treated as such rather than designed around.

### Five distinguishable outcomes

The brief asked for four. Five are required, because conflating transport failure
with an empty list is itself a silent-zero-models bug:

| outcome | meaning |
|---|---|
| `ok{n}` | 2xx, envelope found, `n >= 1` entries |
| `empty` | 2xx, envelope found, zero entries — a true statement about the provider |
| `unsupported-shape` | 2xx, but no candidate envelope key holds an array. **Record the top-level keys observed.** This is a defect in our parser, not a fact about the provider |
| `auth` | 401 / 403 |
| `no-endpoint` | `listing: null` |
| `error{status}` | anything else: 5xx, network failure, timeout, non-JSON body |

`empty` and `unsupported-shape` must never collapse into one bucket. The first
is data; the second is our bug, and it is the exact way rule 3 fails silently.

### Coverage as a reportable number and a gate

`covered = |{ok}| / |eligible|`, where `eligible` excludes `no-endpoint`. Report
the full per-outcome breakdown alongside the ratio, never the ratio alone.

Gate on **two** conditions: a coverage floor, and **zero `unsupported-shape`**.
A shape we cannot parse is a defect and must fail the run; it must not be
absorbed into the denominator as though it were a provider's own limitation.

---

## 2. Where discovery plugs into the pipeline

### Not in `buildProviders`

`buildProviders` (`keysync.mjs:168-240`) is synchronous, pure over injected
inputs, and makes no network call. That is what makes it testable and what makes
keysync a *projection* rather than a fetcher — the split that report 11 identifies
as the whole design. It stays that way.

Discovery is **tier 2 of `refresh/`**, writing into the snapshot as
`discovered[provider] = {outcome, models, at}`. `buildProviders` gains one input
and a resolution order.

### Resolution order

**live listing -> catalogue -> `testModel` -> skip.**

This inverts today's precedence, which is `testModel`-first for the measured
reason recorded at `keysync.mjs:177-181`: preferring catalogue ids dropped the
live pass rate to 4/44.

**That measurement indicts the bundled catalogue, not live listings.** The
catalogue is provider-generic — it aggregates litellm, models.dev and OpenRouter,
which describe what a *vendor publishes*, not what *this key at this tier* may
call. It therefore names models the credential has no entitlement to, and they
404 upstream. A keyed `GET {base}/models` is answered by the same host, on the
same credential, that will answer `/chat/completions`. It is a structurally
better predictor, which is why a live listing may lead where the catalogue may
not.

### Better is not proof: listing-verified versus call-verified

A listing naming a model is not evidence the model is callable. Report 01 carries
the counterexamples in the vault's own `notes`:

- **bai** lists 42 models; 7 respond 200 on a zero-balance key.
- **commandcode** lists 62; all return 400 "insufficient credits".
- **veniceai** lists 112-113; chat 400s on balance.
- **tokenharbor** lists vendor-prefixed ids that are not callable.
- **indeedwebid** lists 200 and chat-502s on every model tried.

A listing is an **entitlement-blind manifest**. So every model entry carries
**provenance**, persisted in the snapshot and badged in the picker:

| provenance | established by |
|---|---|
| `call-verified` | a real completion returned 200 inside the health window — B7's fold over `probe.mjs`, or tier 3's `verify-cli.mjs` |
| `listing-verified` | the provider's own keyed listing named it |
| `catalogue-only` | only catalogue metadata names it |

`testModel` is `call-verified` by construction — it is the probe-verified
known-good id for that key — and stays pinned into the set regardless of ranking.

Ranking within `MAX_MODELS_PER_PROVIDER` orders by **provenance first**, then the
existing free -> id-length -> `localeCompare` tiebreak. A provider that lists 400
models and can call 7 therefore ships its 7. A discovery outcome never upgrades
provenance: `ok{400}` from `bai` still yields one call-verified row plus badged
listing-verified extras.

### Caching, TTL and failure behaviour

TTL 7 days, matching report 11's weekly tier B cadence. Stale-but-present always
beats absent. A provider is **never dropped for a discovery failure** (rule 1):
`auth`, `error`, `empty` and `unsupported-shape` all fall through to catalogue,
then to `testModel`. The outcome is recorded and displayed; it never prunes.

### The amendment B6 needs, and its cost

The plan currently has tier 2 go through CCR's `probeProvider` RPC, specifically
so that the refresher never holds a key value. That RPC cannot express cluster B
(non-`/v1` version segments), cluster C (a `models` envelope) or cluster F
(Cloudflare's `models/search` path), so it **structurally cannot satisfy rule 3**.

Tier 2 must instead call `refresh/discover.mjs`, which reads key values the way
`probe.mjs` already does — one batched PowerShell vault read. Report 11 already
scoped tier B as keyed and weekly-or-manual, so this restores the research's
shape. What it costs is B6's stated "no tier holds a key" property, which now
reads: **only manually-run or scheduled-with-consent tiers hold keys.** That
change must be written into B6's rationale paragraph, not silently dropped.

---

## 3. The revised A5.1

Rule 2 removes name-based rejection from the routing path. It does not remove
sanitisation. The defence becomes five things, four of which already exist.

### 3.1 What is removed

`admitRemoteModels` (`menu/denylist.mjs`) drops the `isReserved` branch in its
loop. Its two call sites in `buildProviders` — `keysync.mjs:183` (catalogue
entries) and `keysync.mjs:197` (the `safeTestModel` guard) — then admit
`claude-opus-5` from any provider.

`admitId` is a separate export and is unchanged. It keeps rejecting escape
sequences, control characters, invisibles, `..`, backslashes, over-length ids,
and keeps the `@cf/...` leading-scope rule. It never tested Claude names.

`RESERVED` and `isReserved` stay **exported** — the collision guard consumes
them, and they remain the single definition of "Claude-shaped".

`UW_ALIAS` stays enforced. It is our namespace, not a vendor's; a provider
claiming `uw/fast` shadows a routing slot we own, and rule 2 says nothing about
that.

### 3.2 S1 — the fatal collision guard

The guard already exists at `keysync/run.mjs:163-186`. **Keep it exactly where
it is:** after `validate()`, before any write, so that `--dry` reports it and
nothing lands.

Three changes:

1. **Widen the regex.** It is currently `/^(claude|opus|sonnet|haiku)([-\d]|$)/`.
   It must gain `fable`, and its boundary class must match `RESERVED`'s —
   `[-._\d\/]` rather than `[-\d]`. Better still, have the guard import
   `RESERVED` from `menu/denylist.mjs` so there is one definition rather than
   two that drift.
2. **`hijackable` becomes fatal.** The predicate is unchanged: a bare
   Claude-shaped id whose owner set has size 1 and does not contain `anthropic`.
   `console.warn` becomes `process.exit(1)`. `shadowed` (owner set size > 1)
   stays a note — ambiguity is a clean failure, not a misroute.
3. **An explicit opt-out is required:** `--allow-bare-claude-names`. Without it,
   a user who genuinely wants a reseller with the relay deliberately off is
   permanently blocked, which violates rule 1.

**This blocks no reseller.** A reseller sharing a name with a *live* relay lands
in `shadowed` and the run proceeds. The fatal case is specifically "relay down,
single reseller is sole owner", which is S1 exactly.

**The error text must name the bare id and its sole owner, and give the remedy
as `start the relay` or `--allow-bare-claude-names` — never "remove the model".**
The remedy wording is load-bearing: an error that tells the operator to delete a
provider's model is an error that teaches rule-2 violation.

### 3.3 S2 — relay alias ownership

Append `opus`, `sonnet`, `haiku`, `fable` to `ANTHROPIC_RELAY.models`
(`keysync.mjs:142`), so the relay owns the four bare aliases Claude Code accepts
and a third-party provider publishing `opus` lands in `shadowed` rather than
becoming sole owner.

Four consequences, stated precisely:

1. **Stage-2 resolution is unaffected.** Every row keysync writes is
   `provider/model`; `anthropic/claude-opus-5` still matches exactly. The
   aliases add reachable targets, they do not redirect existing ones.
2. **`Sd()` will now enumerate `anthropic/opus`** as an available id. Harmless —
   it is namespaced and correctly owned.
3. **The picker gains four duplicate rows unless suppressed.** `run.mjs:108-113`
   maps `ANTHROPIC_RELAY.models` straight into picker rows. The constant must
   therefore split into a **routing list** (8 ids, written into
   `Providers[].models`) and a **picker list** (the original 4, rendered to the
   user). Missing this ships a visibly broken menu.
4. **Precondition — VERIFIED 2026-09-03, and it does NOT hold.** The relay
   performs no model mapping whatsoever. `C:/Users/osami/.local/bin/anthropic-oauth-relay.mjs:246`
   handles `GET /v1/models` by calling
   `forwardToAnthropic(req, res, "GET", "/v1/models", body, false)`, and
   `forwardToAnthropic` (`:155`) attaches an OAuth bearer and forwards the body
   **unmodified**. There is no body rewrite, no alias table, no substitution of
   the `model` field anywhere in the file; its header comment describes
   `/v1/models` purely as "catalog for model discovery". See 3.3a.

A guard-only alias list (detect the collision without writing the aliases into
`Providers[].models`) was considered and rejected: it leaves a sole reseller of
`opus` fatally blocking every run, which is a rule-1 violation dressed as a
security control.

### 3.3a S2 is a two-part change, and the relay half is load-bearing

Because the precondition above fails, appending the four aliases **on its own**
would advertise four ids the relay cannot serve. A stage-4 bind on `opus` would
forward `{"model":"opus"}` upstream, and Anthropic would reject it.

Note what that would and would not accomplish. Today no provider lists bare
`opus`, so a built-in row sending it finds zero stage-4 matches and is left
*unresolved* — it already fails, and it fails cleanly. Appending the aliases
without relay support would make the relay the **sole owner** of `opus`, so the
row would bind and then 404. That trades a rare silent misroute for a common
loud failure — better, but not the fix, and it makes a currently-clean failure
look like a successful route. S2 must therefore land as two parts.

**Part 1 — the relay gains bare-alias mapping.** Before forwarding, if the
request body's `model` field is exactly one of `opus`, `sonnet`, `haiku`,
`fable` (case-insensitive, exact match only — never a prefix or substring test),
substitute the resolved full id. This applies to the request body on the
messages path; `GET /v1/models` continues to forward unmodified.

**Part 2 — keysync appends the aliases** to `ANTHROPIC_RELAY.models`' routing
list, as described in 3.3.

#### Where the mapping comes from

Two candidates were weighed. A hard-coded table is exactly the defect that
started this thread — `providers.json`'s `testModel` values are hand-recorded
ids that nobody re-reads, whose staleness is invisible until a call fails.

**Candidate A — derive from `ANTHROPIC_TIERS` (`keysync.mjs:148-153`).**
Materially better than `testModel` in one respect: those values are written into
CCR config on every keysync run and anchor the picker's Claude rows, so if
`claude-opus-5` were retired the row `anthropic/claude-opus-5` would fail loudly
on the user's primary path. It is self-policing in a way `testModel` is not.
Against it: the relay is a standalone process in `~/.local/bin`, started
independently of `~/.uw`. Importing a keysync constant couples the relay's
startup to this repo's layout; passing it via a written JSON adds a file and a
startup ordering dependency.

**Candidate B — the relay resolves the alias against its own `/v1/models`.**
Self-updating, and the relay already proxies that exact path with the OAuth
bearer (`:246` → `:155`), so the upstream call and its auth are already
implemented — resolution is a filter over a response the relay can already
obtain.

**Recommendation: B, with A's values as a static fallback table.**

Four reasons. (1) The upstream machinery already exists; this is a filter, not a
new integration. (2) It is self-updating, which is the property whose absence
caused this thread. (3) Alias semantics are inherently "the current best X" — a
static pin contradicts what the alias means, and would silently keep routing
`opus` at a superseded model. (4) Decisively: **the static table cannot be
eliminated either way.** Cold start, an unreachable upstream, or a malformed
response all need a fallback, so the table exists regardless. The only real
question is whether it is the primary path or the backstop, and making it the
backstop bounds its staleness to the degraded path.

The fallback values must be read from the same constant that already holds them
(`ANTHROPIC_TIERS` / `ANTHROPIC_RELAY.models`), copied into the relay as a
single table with a comment naming its source — one table, not two that drift.

**Resolution rule, to be specified rather than left to the implementer.** Filter
`/v1/models` entries whose `id` contains the alias token **on a word boundary**
— reuse `RESERVED`'s boundary discipline, so `opus` matches `claude-opus-5` and
`claude-3-opus-20240229` but never `opusculum`. Sort the survivors by
`created_at` descending and take the first. Do not assume the response is
already ordered. Cache the resolved map with a 1-hour TTL, refreshed lazily on
first use after expiry, never on a timer.

**Failure behaviour.** If dynamic resolution fails *and* the fallback id is
rejected upstream, return a 4xx whose body names the alias and says it could not
be resolved. **Never forward the bare alias upstream** — that is the 404 this
subsection exists to prevent, and it must not be reachable by falling through.

#### Ordering, enforced at runtime rather than only in the plan

The relay change must land **before or with** the alias append, never after, or
the four advertised ids are dead on arrival.

Plan ordering alone is not enough, because the relay is a separate process the
user may not have restarted. Make it a runtime gate: `run.mjs`'s relay liveness
probe (`:98-105`) already sets `anthropicOn`; give it a second field,
`aliasesOk`, established by asking the relay whether it resolves the aliases —
either a small `/aliases` endpoint or an added field on `/health`. Then:

- `aliasesOk === true` → write the 8-id routing list; a reseller publishing
  `opus` lands in `shadowed`.
- `aliasesOk === false` → write only the 4 full ids, exactly today's behaviour,
  and let the S1 guard treat bare aliases as unowned.

No dead rows are ever written, the two halves can land in either order without a
broken intermediate state, and an operator running a stale relay binary gets
today's behaviour rather than a menu of ids that 404.

**Is S2 worth carrying at this cost? Yes.** The relay is code we own, it has a
`.bak-preharden` sibling so it has been modified deliberately before, and the
runtime gate makes the change safe to land incrementally. The alternative —
accepting S2 as residual risk — would mean a provider publishing bare `opus`
becomes its sole owner even with the relay up, which is the one case where rule
2's "prevent silent misrouting" defence has no other backstop: S1 does not fire,
because the relay being live is precisely what S1 checks for.

### 3.4 Labelling

Rows carry the hostname parsed from `api_base_url` in `description` —
`tabiai > claude-opus-5 . tabitoken.com` versus
`anthropic > claude-opus-5 . 127.0.0.1:4517`. A vault nickname is user-chosen and
can be made to read as official; a hostname cannot. `keysync.mjs:247-250` already
emits `model` / `label` / `description`.

**Never surface `row.behavesAs`** (`keysync.mjs:120,256`). It is a client-side
prompt profile, not a selector, and displaying it would read as a claim about
which model is answering.

### 3.5 The CCR `resolve()` relay-preferring tiebreak: skip

Recommended **against**, agreeing with the team lead. It mitigates only S3, which
was assessed as near-cosmetic — `ANTHROPIC_TIERS` is namespaced
(`keysync.mjs:148-153`), the `/model` pin reconciles against `built.picker`
(`run.mjs:448`), and session start resolves at stage 2, so only a leftover
built-in row clicked in the UI fails, and it fails cleanly.

The cost is a **second** local patch to `dist/main/cli.js` — a file a global
reinstall has already wiped once, and whose loss would be silent. One patch that
must be re-applied after every reinstall is a known hazard; two is a hazard plus
an ordering dependency.

---

## 4. Task deltas

Against the current numbering in `plans/phase6-menu-and-catalogue.md`.

| Task | Line | Disposition |
|---|---|---|
| **A5.1** | 1838 | **Amended, not replaced.** Drop `isReserved` from `admitRemoteModels`' loop; keep `RESERVED` / `isReserved` exported for the guard; keep `admitId` and `UW_ALIAS` unchanged. **Gains four steps:** (a) S1 fatal — widen the guard regex to include `fable` and the full `[-._\d\/]` boundary, ideally by importing `RESERVED`, and turn `hijackable` from `console.warn` into `process.exit(1)` with the `--allow-bare-claude-names` opt-out; (b) S2 part 2 — append the four bare aliases to `ANTHROPIC_RELAY.models`' routing list and split the constant into a routing list (8 ids) and a picker list (4 ids), **gated on `aliasesOk`** so nothing dead is ever written; (c) the hostname `description`; (d) extend the relay probe at `run.mjs:98-105` to establish `aliasesOk` alongside `anthropicOn`. **A5.1 now depends on A5.2** (below) and must not append the aliases ungated. **Its hostile-`opus` test inverts:** it must now assert that the id *survives* under a namespaced `provider/model` row, that no bare `opus` is sole-owned by a non-relay provider, and that the guard exits non-zero when it is. The old assertion — that the id is absent from `Providers[].models` — becomes wrong under rule 2 and must be deleted, not weakened. |
| **A5.2** | *new* | **S2 part 1 — the relay bare-alias mapping.** A second new task, and a hard prerequisite of A5.1's step (b). Adds to `C:/Users/osami/.local/bin/anthropic-oauth-relay.mjs`: exact-match substitution of `opus` / `sonnet` / `haiku` / `fable` in the request body's `model` field before forwarding; dynamic resolution against the relay's own `/v1/models` with a 1-hour lazy cache; a static fallback table copied from `ANTHROPIC_TIERS` with a comment naming its source; a 4xx-with-named-alias failure path that never forwards a bare alias upstream; and the `aliasesOk` signal on `/health` (or a small `/aliases` endpoint) that A5.1 step (d) reads. Separate from A5.1 because it edits a different file in a different tree, and because the runtime gate lets the two land in either order without a broken intermediate state. |
| **B2** | 6780 | **Body unchanged**, but its prerequisite gate must be rewritten. The gate at line 9694, and the first test in `infertier.test.mjs` (described at 6807-6824), assert *name absence* from `buildProviders`' output. After A5.1's revision that assertion is false by design and will fail permanently. Rewrite both to assert that the collision guard fires. Constraint 11 at line 25 and the pre-mortem Scenario 3 at line 168 both state the old rule in prose and need the same correction. |
| **B5** | 7473 | **Gains schema.** The snapshot carries `discovered[provider] = {outcome, models, at}` and a per-entry `provenance` field (`call-verified` / `listing-verified` / `catalogue-only`). B5 already carries the ETag through; this is an additive change to the same record. |
| **B6** | 8080 | **Largest change.** Tier 2's transport moves from CCR's `probeProvider` RPC to a new `refresh/discover.mjs`. The `Outcome` type gains the six-value enum (`ok`, `empty`, `unsupported-shape`, `auth`, `no-endpoint`, `error`). `discover.mjs` lifts `headersFor` from `key-health.mjs:41`. The "no tier calls probe.mjs / the refresher never holds a key" rationale paragraph must be **rewritten, not deleted** — the property genuinely changes to "only manually-run or consented tiers hold keys", and the reason it changed (the RPC cannot express clusters B, C and F) belongs in the plan. The existing `refresh/ never imports the test harness` grep test still applies to `discover.mjs`. |
| **B7** | 8708 | **Gains a role.** The health fold over `probe.mjs` output becomes the producer of `call-verified` provenance. No change to its age-refusal logic. |
| **B8** | 9223 | **Gains an assertion.** Alongside `EXPECTED_PROVIDERS` becoming a floor, add a discovery-coverage floor and a hard `unsupported-shape === 0` check. |
| **B9** | 9331 | **Check only.** The deliberate tiebreak run must be re-derived with provenance as the leading sort key; if the recorded tiebreak outcomes were computed without it, they are stale. |
| **B6.1** | *new* | **Yes, a new task is needed** — see below. |

### B6.1: curating the `listing` keys into `providers.json`

**A new task is required, and it must be modelled on Task B3** (line 6991), which
already establishes the correct shape for this project: `grantCadence` is added
to `providers.json` by a **documented prose migration the user applies by hand**.

`~/.llmkeys/providers.json` is hand-maintained and never machine-written. Adding
`listing` keys is therefore **a documented human step, not a code change.** B6.1
must be written accordingly:

- **Human half:** a migration table giving the exact `listing` block to paste for
  each of the entries that needs one — `cloudflare` (absolute URL override,
  `result` envelope, `["name","id"]` idField), `youcom` (`listing: null`),
  `githubcopilot` (`listing: null`), `anthropic` (`listing: null`). The other 43
  entries are untouched; omitting the key means cluster-A defaults.
- **Code half:** ship the defaults, so the 43 untouched entries keep working, and
  add a test that loads the vault and fails if any entry in a curated exception
  list lacks a `listing` key. That test is what stops the human step from being
  quietly skipped.
- **Probe half:** resolve the two open unknowns as data — `xai` (cluster A, but
  absent from the Maestro cache with no note) and `commandcode` (`notes` say
  `GET /models`, `baseUrl` ends `/provider/v1`). Record the answer as a `listing`
  key if either turns out to deviate.

B6.1 is separable from B6 because it is **data, not code**, and its acceptance
criterion is the coverage number rather than a passing unit test.

---

## Where rule 3 cannot be fully met

This must be stated to the user rather than buried.

**`githubcopilot` and `youcom` have no listing endpoint that exists.**
`githubcopilot` has no sanctioned REST surface and an empty `baseUrl`; `youcom`
is a web-search API whose `/models` and `/chat/completions` both return 403, and
whose own vault note says "Not usable as a maestro backend." Both are
`listing: null`, both are already excluded by `filterRegistry` for protocol
`generic`, and both are excluded from the coverage denominator.

Consequently **a coverage report of 100% means "100% of the 44 eligible
providers", never "of 47"**, and the report must print it that way.

Further, anything counted as covered must have produced a live `ok` inside the
current TTL window. Providers standing on `testModel` only, or on catalogue data
only, must be **counted and displayed separately**. Folding them into the covered
figure is the exact false assurance this design exists to prevent: it would let
the user be told discovery is complete while a provider is silently shipping one
stale hand-recorded id.

---

## Appendix: verification record

### `Sd()` — verified directly, this session

Read from `C:/nvm4w/nodejs/node_modules/@musistudio/claude-code-router/dist/main/cli.js`
at byte offset 875300, and cross-checked by grepping the function body.

`Sd(e)` calls `m_e(e.Providers)`. `m_e` is
`e.flatMap(t => ... !Array.isArray(t.models) ? [] : t.models.flatMap(...))` —
**a flat map over `Providers[].models[]` with no per-model opt-out.** The only
gates are `Oe(t)` (the enabled check), a non-empty trimmed `t.name`, and
`t.models` being an array. There is no per-model flag, no filter hook, and no
exclusion list. **The briefed conclusion is confirmed.**

One correction worth carrying into the plan: every id `Sd` emits is
**namespaced** — the map is `` `${n.providerName}/${n.modelName}` `` — plus
`virtualModelProfiles` prefixes and suffixes, and `exactAliases`, which are
force-prefixed `Fusion/` unless they already start `fusion/`. So `Sd` is the
**availability enumerator**, feeding `ic()` and the `dy()` throw whose message is
`Rd` ("No available models. Configure at least one provider with a model before
starting CCR Gateway or opening an agent through CCR."). It is **not** the
bare-match surface.

The `exactAliases` force-prefix is separately relevant to `UW_ALIAS`: UW's
`virtualModelProfiles` aliases will surface as `Fusion/<alias>`, not `<alias>`.
Whoever implements the stage-3 defence-in-depth should confirm that is the
intended selector shape.

### Still unverified — do not treat as established

1. **`providerModelMatches`**, approx. offset 1000600-1000800 in the same file.
   This is where the stage 4-5 bare-name matching actually lives, and the S1
   hijack path rests on it. I did not read it. Have it verified separately.
2. ~~Whether the local Anthropic relay maps the bare aliases.~~ **RESOLVED
   2026-09-03 — it does not.** Verified by the team lead against
   `C:/Users/osami/.local/bin/anthropic-oauth-relay.mjs`: `:246` forwards
   `GET /v1/models` via `forwardToAnthropic`, `:155` attaches an OAuth bearer and
   forwards the body unmodified, and there is no alias table or `model`-field
   substitution anywhere in the file. S2 is consequently a two-part change; see
   section 3.3a.
3. **Cloudflare's per-entry id field** in the `models/search` response — `name`
   versus `id`. Handled as data via the `idField` list rather than guessed.
4. **`xai`** and **`commandcode`** listing behaviour — one probe each, folded
   into B6.1.

### Files this design touches

- `C:/Users/osami/.uw/keysync/keysync.mjs`
- `C:/Users/osami/.uw/keysync/run.mjs`
- `C:/Users/osami/.uw/menu/denylist.mjs`
- `C:/Users/osami/.uw/keysync/key-health.mjs` (source of `headersFor`)
- `C:/Users/osami/.local/bin/anthropic-oauth-relay.mjs` (S2 part 1 — bare-alias
  mapping and the `aliasesOk` signal; has a `.bak-preharden` sibling, so
  deliberate modification is established practice)
- `C:/Users/osami/.uw/refresh/discover.mjs` (new)
- `C:/Users/osami/.uw/refresh/tiers.mjs`, `cli.mjs` (B6)
- `~/.llmkeys/providers.json` (hand-edited, B6.1)
- `C:/Users/osami/.uw/plans/phase6-menu-and-catalogue.md` (planner folds in)

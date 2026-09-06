# Open questions

Unresolved items surfaced during planning. Append; do not rewrite history.

## Standing project rules

- **A provider that is alive and responding is never classified dead or removed from routing.**
  Set by the user 2026-09-06. Governs the whole project, not one branch.

  > Account-state failures — insufficient funds, overdue balance, wrong or expired API key, missing
  > credits or licences, eligibility walls — are **state**, not death. Surface them in the uwpick menu
  > (the existing `health` column, or a new column) and never use them to block or eliminate routing.
  > Only a genuinely absent model (404 / "does not exist"), a decommissioned one, or a provider that
  > does not respond at all may be treated as unroutable.

  **Evidence, measured 2026-09-06.** 57 of 218 live probes (26%) failed on money rather than absence:
  `402 Payment required`, `402 Insufficient Balance`, `403 Access to model denied`. Alibaba had 343
  models catalogued and 73 entitled; two are recorded passing the real-client gate in
  `keysync/verified-rows.json` on 2026-09-01, then returned 403 on everything five days later over an
  unpaid bill.

  **The scar is already in the repo's own words.** `keysync/verify-cli.mjs:38-39`: pruning on a
  transient failure is *"a one-way ratchet: a row dropped for a transient failure was never probed
  again, which is how mistral was lost to a single 503."* An unpaid balance is worse than a 503,
  because a 503 clears itself and a balance does not clear until the user acts.

  **`--verified-only` is non-compliant today.** `keysync/run.mjs:363-380` filters `built.providers`
  as well as `built.picker`, so running it while a provider is unfunded deletes that provider's
  entire catalogue from **routing**, not just from the picker. Pre-existing and out of scope for
  `fix/model-capability-buckets` — flagged here so nobody cites it as precedent for pruning on a
  live-but-unpaid signal, which an earlier revision of that plan did.

  This rule is why D9-A (dim, never skip, on `routable`) is the only compliant choice for the
  routability work in `plans/model-capability-buckets-plan.md`.

  ### The classification table this rule implies

  Designed with the user 2026-09-06, from the 218 real probe responses. `prune` means deleting the
  row from **both** `built.picker` and `built.providers` — the model leaves CCR's routing config,
  `resolve()` stage 2 misses, and selecting it errors. The three weaker actions all keep the row
  routable.

  | # | class | signal | scope | recoverable by | prune? | surfaced as |
  |---|---|---|---|---|---|---|
  | 1 | absent | 404/400 "model does not exist", "unknown model" | model | nothing | **yes** | row gone |
  | 2 | decommissioned | 410, "EOL", "deprecated", "no longer available" | model | nothing | **yes** | row gone |
  | 3 | not-chat | 400 "not a chat model"; wrong-endpoint errors (embeddings, realtime, `v1/responses`) | model | nothing | no | dim + skip |
  | 4 | policy | 403 with a policy reason (OpenRouter *"only available on agentic harnesses"*) | model | request shape, maybe | no | mark, selectable |
  | 5 | unfunded | 402 payment/balance/insufficient; 403 "access denied"/"not eligible"; "no credits or licenses" | **provider** | paying | no | `health` |
  | 6 | bad-auth | 401 invalid/inactive/missing key | **provider** | fixing the key | no | `health` |
  | 7 | undeployed | 404 `Function '<uuid>': Not found for account '<id>'` (nvidia) | **provider** | deploying at the provider | no | `health` |
  | 8 | transient | 429, 5xx, timeout, connection reset | either | waiting | no | nothing — retry |
  | 9 | listing-empty | 200 with `data: []` (tabiai, gorouter) | **provider** | unknown | no | `health` |
  | 10 | unreachable | DNS failure / connection refused, sustained across retries **and runs** | **provider** | provider returning | yes | provider gone |

  **Only classes 1, 2 and 10 may prune.** That is the standing rule expressed mechanically.

  Two properties the table depends on:

  - **The message classifies, not the status code.** Three measured counterexamples: nvidia returns
    `404` for account deployment state (class 7, 45 models), alibaba returns `403` for billing
    (class 5, 343 models), and bluesminds returns `410` for genuine EOL (class 2). A code-only
    classifier prunes classes 5 and 7 — precisely the cases this rule exists to protect.
  - **Provider scope beats model scope.** Classes 5, 6, 7 and 9 apply to every model under that
    provider at once, so one `402` settles the provider and the remaining models need no probe. It
    also keeps the picker honest: `health` is already per-provider (`healthOf(prof)`), so an
    unfunded provider reads as unfunded once rather than as 343 identical per-row marks.

  Class 3 converges with the `outputKind: "nontext"` work already in
  `plans/model-capability-buckets-plan.md` — the catalogue's `modalities.output` predicts it, a probe
  confirms it, same conclusion by two routes.

  Three consumers when this is built: `--verified-only` (non-compliant today, see above), any
  re-probing in the reachability follow-up (which should write the class, timestamped, per model),
  and `health`, which is currently derived from static profile data rather than from probe results.

## Decided follow-ups (not open questions)

- **`MAX_MODELS_PER_PROVIDER` is deprecated as a design. Remove it in a later branch.**
  Decided by the user 2026-09-06. Both stated justifications are moot: **menu size**, because uwpick
  is the real picker and the native `/model` menu is a separate surface; and **attack surface**,
  which is a real concern but is to be solved on its own terms rather than by capping reach. The
  project's aim is to route as many working models as possible. The original rationale
  (`keysync/phase6-design-notes.md:330-331`, standing constraint 27 at
  `plans/phase6-menu-and-catalogue.md:46`) is kept for provenance, not as an endorsement.

  **It is a decoupling, not a deletion.** `keysync/keysync.mjs:349-372` builds `Providers[].models`
  and the picker rows from **one array**, so the cap sizes routing and declaration together. The two
  must be split before either can be sized independently.

  **One hard functional blocker, ahead of any security question:** `checkBareCollisions`
  (`keysync/run.mjs:71`) is a fatal exit, and widening pulls in every bare Claude-shaped name any
  reseller publishes. keysync would refuse to run before the security question is even reached.

  **`fix/model-capability-buckets` is a prerequisite — but not in the direction first written.**
  Widening the cap widens `Providers[].models`, which is exactly what `routableFromConfig`
  (`menu/ccr-client.mjs:178`) reads, so it moves rows from `routable: false` to `true` and **reduces**
  uwpick's dimmed count; uwpick already renders all 1,588 rows either way. Where widening adds rows is
  the **native `/model` menu, which has no dimming at all.** So the real relationship is that task T4
  gives uwpick the only surface capable of distinguishing reachable from unreachable, and widening
  before it would grow the one surface that cannot. This does not change the current branch: the
  load-bearing claim — that 83 is today's *complete* routable set, which is why the declaration
  channel and the routing config are the same set — is true regardless of whether the cap should
  exist.

  A live measurement of how many of the 1,588 catalogued models the user's keys actually serve is
  running separately and will size this follow-up. Nothing here blocks on it.

## model-capability-buckets — 2026-09-06

- [x] **OQ-1: does the healthy keysync path still write the 83 non-Anthropic rows to `settings.json`?**
  **RESOLVED 2026-09-06** by direct binary read (build 2.1.261). Three findings:
  (1) the live file is **stale**, not a relay-down artifact — `keysync/run.mjs:867`'s
  `scopeNativePickerOptions` would have written 4 rows with the relay up, so keysync has not run
  `--target live` since commit `4151639`;
  (2) `modelPicker.options[]` serves **two roles at once** — it is both the rendered `/model` row list
  (`Ato()` iterates it) and the only registry that can hold `behavesAs` (`_re()` reads it from the
  same array), so dropping a row drops that model's capability declaration;
  (3) therefore the scoping is a **silent capability regression** on the healthy path: an id with no
  `behavesAs` resolves through `lH()` to the maximal assumption set (every effort tier, adaptive
  thinking on, thinking un-disableable) plus an unknown-model launch warning, which report 18 §3
  measures as strictly worse than any bucket target.
  **Outcome:** Decision 4 reversed — all rows return to `options[]`, Anthropic first. Task T1 in
  `plans/model-capability-buckets-plan.md`, a hard prerequisite of T7. Full rationale and the dead
  alternatives (`modelOverrides`, a hidden-row field, `modelSettings`) in
  `plans/claude-sub-models-plan.md` under "Decision 4 REVERSED, 2026-09-06".

- [x] **OQ-2: if the healthy path drops the 83 rows, what supplies `behavesAs` for a uwpick switch?**
  **RESOLVED 2026-09-06 — and it was not an artifact of the stale-file confusion.** The answer is
  *nothing*: `_re()` reads `behavesAs` from `modelPicker.options[]`, so a dropped row is a dropped
  declaration, and `lH()` then resolves the bare id to the maximal assumption set. The question was
  correct on its own terms and became the load-bearing reason for reversing Decision 4 rather than a
  loose end. Closed by task T1; kept closed by validation rule V7.

- [ ] **OQ-3: `nvidia/bge-m3` is an embedding model that CCR's merged catalogue declares as
  `modalities.output: ["text"]`.** The non-chat classifier will pass it as a chat model. — Confirms
  `modalities.output` is a positive-signal-only discriminator, not a complete one. Worth an upstream
  note to CCR; recorded here so the miss is documented rather than rediscovered as a bug. Out of
  scope for `fix/model-capability-buckets`.

- [x] **OQ-4: the routable-dimming machinery is inert — 1,588 of 1,588 snapshot models carry no
  routability, while CCR routes only 91.**
  **CLOSED 2026-09-06 by scope change**, at the user's direction: folded into
  `plans/model-capability-buckets-plan.md` as task T4 rather than deferred, because report 17's
  decided two-keystroke `/autocompact` flow consumes the same snapshot and should not be built on an
  artifact whose routability field is absent.
  Investigation found the cause is **not** "the snapshot was built while the gateway was down". It is
  **five independent breaks, each of which masks the others**, so fixing any one alone would have
  produced exactly today's artifact:
  (B1) `menu/catalog.mjs:226-228`'s `build()` never passes `routableOf`, so it defaults to
  `() => null` — **`routableSet()` is called by nothing but its own test**;
  (B2) `menu/snapshot.mjs:29-32`'s `buildSnapshot` maps models to an explicit 8-key literal that omits
  `routable` — the live snapshot's models have **no own `routable` property at all** (`undefined`, not
  `null`);
  (B3) `buildSnapshot` never writes the top-level `routableAsOf` stamp that `menu/uwpick.mjs:56` reads
  and `menu/style.mjs:269-271` renders — so the disclosure `menu/catalog.mjs:122-126` says exists
  precisely to stop this failure being silent was itself never wired;
  (B4) `test/snapshot.test.mjs:39` asserts the model key set *without* `routable`, so a currently
  green test certifies B2 as correct;
  (B5) **the causal root** — `menu/catalog.mjs:107-110` states `routableSet` "has exactly one caller,
  `refresh/cli.mjs`", and **there is no `refresh/` directory**. `plans/phase6-menu-and-catalogue.md:289`
  lists it as the planned owner of routability stamping; it was never built. The wire was not
  forgotten, it was designed to originate in a module that does not exist, under a comment asserting
  the caller does — so anyone auditing `routableSet` met a confident sentence instead of an absence.
  Decided as part of the fold-in (plan D9): `routable: false` **dims only, it does not skip the
  selector** — it is a perishable measurement of CCR's configuration, whereas a non-text modality is a
  fact about the model. Severity supports it: `ModelRegistry.resolve()`
  (`research/phase6/03-ccr-capabilities.md:150-184`) returns `undefined` on a miss, so selecting a
  non-routable row fails loudly rather than silently rerouting.

- [ ] **OQ-5: `inferTier` is dead — it returns `"unknown"` for all 4,298 catalogue entries.**
  Probe-confirmed 2026-09-06: `keysync/keysync.mjs:88` reads `pricing.inputPerMillion` /
  `pricing.input` / `pricing.output`, while CCR's merged schema stores
  `pricing.offers[].per1MTokens.{input,output}`. **A usable number is found in 0 of 4,298 entries.**
  Two consequences: the free-first sort at `keysync.mjs:365` is a no-op, so per-provider model
  curation is by shortest id alone; and `keysync.mjs:412`'s tier label is always `""`, so every
  picker row's description is the host and nothing else. — `menu/catalog.mjs:29-31` already documents
  this verbatim and works around it with its own `priceOf`, so the fix is to make `inferTier` read
  the same path rather than to discover anything. Out of scope for
  `fix/model-capability-buckets`; surfaced there because T3 nearly cited `inferTier` as its exemplar
  for honest-unknown labelling, which would have been unfortunate in a plan whose first principle is
  exactly that.

# Research: catalogue refresh architecture (2026-09-02)

## The decisive finding

**You already have a catalogue, and it is free.** CCR's `dist/models.json` is 19.7 MB, 4,298
models across 217 providers, with exactly the metadata wanted (pricing offers,
`limits.contextTokens`, `modalities`, `capabilities`) — and its `sources` block shows it is
built from three **public, unauthenticated** endpoints: litellm's raw GitHub JSON,
`models.dev/api.json`, and OpenRouter's public `/api/v1/models`.

So the metadata half of "catalogue refresh" needs **zero API keys, zero quota, zero
rate-limit exposure.** What it does *not* cover is ~25 of the 47 vault providers (the small
routers plus `xai`, `bigmodel`, `githubcopilot`, `veniceai`, `nousresearch`…). Those need an
authenticated `GET {baseUrl}/models` — cheap, but keyed.

**Recommendation: a three-tier refresh with three cadences and three risk profiles, run by a
separate scheduled task that never talks to CCR and never writes `settings.json`. The
refresher produces a snapshot; keysync consumes it. That split is the whole design.**

## What exists today

- `keysync.mjs:73` hard-codes `CATALOG_FILE` inside `node_modules`. `loadCatalog()` groups by provider; `inferTier()` reduces `pricing` to free/paid/unknown; `buildProviders()` picks at most **3 models per provider** (`MAX_MODELS_PER_PROVIDER`, `:114`).
- Vault `testModel` **leads** and catalogue entries are appended as extras — deliberately, after measuring that catalogue-first dropped the live pass rate to **4/44** (`keysync.mjs:177-181`).
- The picker row carries `contextTokens`, then `run.mjs:464` strips it: `built.picker.map(({ contextTokens, ...row }) => row)`. **Context window is computed and discarded.** The only channel from catalogue to user is `label` and `description`.
- CCR has its own auto-refresh: a `600*1e3` timer gated on `Providers.some(t => t.autoFetchModels)`, whose result path returns `{configChanged:!0, config:{…}, providers:o}` — a *config-mutating* refresh loop, i.e. the restart hazard on a 10-minute cron. keysync correctly sets `autoFetchModels:false` on every provider (`keysync.mjs:219`), disabling the timer entirely.
- The supervisor is `\UW Process Supervision`, `PT5M` repetition, running `uw-supervise.ps1 -Once`. Its stated intent is "ensure running, not a heal state machine", and it already carries a scar: `-Wait` on `ccr start` combined with `MultipleInstances=IgnoreNew` made supervision "alive-but-inert".

## The ratchet is only half fixed

`run.mjs:126-132` writes `built-rows.json` (the full built set, pre-pruning) and
`verify-cli.mjs:38-45` probes that instead of the shipped picker. That fixes "a dropped row is
never probed again".

But `verify-prune.mjs:113-117` still writes `verified-rows.json` as a **full overwrite**,
where `working` is only *this run's* passes. A run during which 6 providers are transiently
down produces a `verified-rows.json` omitting them, and `--verified-only` (`run.mjs:83-86`)
ships a picker without them. **The ratchet is no longer permanent, but a single bad run still
degrades the shipped artifact.** Any refresher inherits this shape unless the merge policy is
designed against it explicitly.

## The restart predicate is order-sensitive, and the model sort is not total

`restartRelevantFingerprint()` (`safety.mjs:248-291`) deliberately does **no sorting**, with a
correct comment: CCR's compare is `JSON.stringify`, order-sensitive at every level including
each provider's nested `models` array.

Now the ranking that decides which 3 models get in (`keysync.mjs:196-199`):
```js
.sort((a, b) => (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) ||
  a.m.model.length - b.m.model.length);
```
**Not total.** Two models with the same tier and same id length keep their input order — the
order they appeared in `models.json`. A catalogue refresh that reorders the upstream file
reorders the selection, changes `provider.models[]` ordering, changes the fingerprint, and
**restarts the gateway for a no-op**. A live foot-gun the moment catalogue refresh becomes
routine.

## Root cause

**Catalogue data and gateway-configuration data are currently the same artifact, so freshness
and stability are in direct conflict.**

Everything wanted from a refresh (pricing, context, modality, richer lists) is *display and
selection* data. The only things CCR consumes are the provider set and each provider's
`models[]`. Today a change in the former propagates into the latter through `buildProviders`,
so any metadata improvement risks a gateway restart, and any restart risks a live session.

The fix is not a better refresh loop. It is to **make the catalogue a separate, keyless,
restart-free store, and make its projection into CCR a rare, deliberate, already-guarded
act** — which is what keysync already is.

---

## 1. Trigger strategy — three tiers, three cadences

| Tier | What | Needs keys | Cadence | Touches CCR / settings.json |
|---|---|---|---|---|
| **A — Metadata** | 3 public GETs (models.dev, litellm raw, openrouter) | No | Daily, own scheduled task | **Never** |
| **B — Model lists** | `GET {baseUrl}/models` per vault provider | Yes (read-only) | Weekly, or manual | **Never** |
| **C — Liveness** | `verify-cli.mjs` (spawns real `claude.exe`) | Yes, spends tokens | **Manual only** | **Never** |
| **Apply** | `keysync run.mjs --target live` | Yes | Manual, deliberate | Yes — locked, fingerprinted, health-polled |

**Effort: medium. Impact: high** — removes the refresh/restart coupling entirely.

Rejections, with reasons:

- **SessionStart hook: stay dropped, and do not revive it in a weakened "just a TTL check" form.** CC reads `modelPicker` at process start, so a hook cannot help the session it fires in. But there is a second, worse reason: a SessionStart hook makes *the number of concurrently starting sessions* the concurrency multiplier on a 44-provider fan-out. Three terminals = 132 in-flight authenticated requests against per-account rate limits. It also puts network latency on the critical path of every session start.
- **Do not put the refresher in the 5-minute supervisor.** That task's contract is availability. Adding a network fan-out re-creates the documented failure: a slow or hung action under `IgnoreNew` means later runs are skipped and supervision goes alive-but-inert — and supervision is what keeps CCR and the relay up. **A watchdog must be the fastest, dumbest thing in the system.**
- **Lazy/on-demand on browse-UI open: yes, but only as a *staleness read*, not a blocking refresh.** The UI reads the snapshot, shows `age: 3d`, and offers a button. It must never block on a fan-out.
- **TTL: use it to *gate* the scheduled run, not to trigger refreshes from arbitrary code paths.** The daily task starts, checks `index.json.generatedAt`, exits in ~5 ms if fresh. That is the entire TTL mechanism.

**On "only benefits the next session" — state it as a design rule, not a caveat:** the
refresher **never writes `settings.json`**. Then the constraint stops being a limitation and
becomes a non-issue. The picker changes only when the user runs keysync, at which point they
already know they are changing routing for new sessions — that is what `--i-know` is for.
**Any design where a background job silently rewrites `modelPicker` is the 2026-09-01 outage
with a cron trigger attached.**

## 2. Fan-out and partial failure

**Effort: low. Impact: high — this is where the previous defect lived.**

- Concurrency **6** (not 44). The existing probe used 5 (`verify-prune.mjs:104`). Several vault providers proxy the same upstreams, and rate limits are per-account, not per-host.
- Per-provider timeout: 10 s to first byte, 20 s total. Whole-run wall-clock budget 120 s, then hard-abort — a refresher that can hang will hang.
- Retries: **1** on network error or 5xx, jittered 2-5 s. **Zero retries on 429** in scheduled mode. Retrying a rate limit on a schedule is how you get banned.

**Merge policy — the load-bearing part.** Three outcome classes, only one carrying negative
information:

| Outcome | Meaning | Effect on stored models |
|---|---|---|
| `ok` | 2xx with a parseable list | Authoritative. Union in new models; increment `missCount` on stored models absent from the response |
| `soft` | timeout, 5xx, 429, DNS, abort | **No information.** Touch nothing. Bump a `soft` counter for observability only |
| `hard` | 401 / 403 | Key is dead. Flag the *provider*, surface loudly. **Still do not touch its models** |

**The rule to write on the wall: absence of evidence is not evidence of absence.** The old
ratchet failed because a transient 503 was treated as a statement about the model set. It was
a statement about the network.

Eviction requires all three: `missCount >= 3` **and** those misses came from distinct `ok`
runs **and** `lastSeen` older than 14 days. Even then, prefer `status: "retired"` over
deletion.

Two whole-run circuit breakers:
- **Per-provider shrink guard:** an `ok` run that would drop a provider to zero models, or cut it by more than 50%, is rejected for that provider and the previous entry retained; requires `--accept-shrink` to land. This catches upstream schema drift — the realistic failure. models.dev renaming a field yields a clean 200 with an empty parse, which looks exactly like "the provider deleted everything".
- **Whole-snapshot floor:** if total models < 80% of the previous snapshot, refuse to promote. Catches a GitHub-raw outage returning a valid-but-empty document.

`verified-rows.json` needs the same treatment: stop overwriting `working` with only this run's
passes. Make it `{model, lastOk, lastFail, consecutiveFails}`, have `--verified-only` filter
on `consecutiveFails < 2`, and **refuse to run at all when `generatedAt` is older than N
days** — today `run.mjs:76-95` happily ships a picker built from a `verified-rows.json` of
arbitrary age.

## 3. Cache design

**Location: `~/.llmkeys/catalogue/`** — next to the vault it describes, not in `.uw`
(tooling) and emphatically **not in `node_modules`**.

```
catalogue/
  current                       <- one line: "2026-09-02T04-00-00Z"
  snapshots/
    2026-09-02T04-00-00Z/
      index.json                <- generatedAt, per-provider status/counts, source versions
      providers/<name>.json     <- one file per vault provider
      raw/models-dev.json       <- upstream snapshots, retention 2
```

- **Per-provider files, not one blob.** Partial failure maps naturally onto "write the files that succeeded"; a corrupt write loses one provider, not 44; no reader ever does a read-modify-write on 19 MB.
- **Crash safety:** write into a new snapshot dir (nothing live touched), then `index.json` via temp+rename, then flip `current` via temp+rename **last**. A crash anywhere leaves the previous snapshot intact and the partial dir orphaned; the next run GCs dirs not named by `current`. Reuse `atomicWriteJson` (`safety.mjs:353`) — it already handles the two measured Windows caveats (ACL inheritance on rename, EPERM/EBUSY retry).
- **Per-provider staleness, not global.** Each file carries its own `lastOk`, `lastAttempt`, `source` (`public` | `endpoint` | `vault-testModel`), `confidence`. A global TTL would mark 22 providers stale because 25 others were unreachable.
- Retention: 3 snapshots.

## 4. Cost and rate-limit exposure

- **Tier A is genuinely free.** Three unauthenticated GETs. No key ever leaves the vault. Covers 22 of 47 providers with full pricing, context and modality. **If you build only one thing, build this.**
- **Tier B costs approximately nothing but is not zero-risk.** `GET /v1/models` is a listing call, not a completion, so it consumes no tokens. But 16 vault providers have `requiresBalance: true`, and small routers sometimes meter *any* authenticated request. Mitigations: weekly not daily; concurrency 6; no 429 retries; and **honour the vault's own trust notes** — `providers.json` carries hand-written judgments like *"treat with some caution, avoid routing sensitive prompts until more trusted"* on `teamorouter`. A provider flagged untrusted should not receive an automated weekly authenticated ping without explicit opt-in.
- **Tier C is the only thing that spends money.** `verify-cli.mjs` spawns the real `claude.exe` per row — at ~89 rows that is 89 real completions with a full Claude Code payload. **Never schedule this.** Add a `--only <provider>` flag so re-verifying one provider does not re-bill the other 43.
- Add a global kill file: if `catalogue\PAUSE` exists, every tier exits immediately. When something goes wrong at 3 a.m. you want a one-file stop, not a task-scheduler expedition.

## 5. Decoupling from the restart hazard

1. **Fix the non-total sort.** Add `|| a.m.model.localeCompare(b.m.model)` to `keysync.mjs:197-199`. Without it, a catalogue refresh that merely reorders upstream rows reorders `provider.models[]`, changes the order-sensitive fingerprint, and restarts the gateway for zero semantic change.
2. **Keep `autoFetchModels: false` forever, as a guarded invariant.** CCR's built-in 600 s refresh returns `configChanged: true` with rewritten providers. Enabling it hands the restart trigger to a timer you do not control. Add it to `validate()` as a hard failure rather than relying on `buildProviders` always setting it.
3. **Catalogue metadata reaches CCR through exactly one channel and it is a string** — `label` and `description`. Since `run.mjs:464` already strips `contextTokens`, richer metadata has *no path* into `Providers[]` at all. **That is a feature**: a Tier A refresh that improves every price and context window produces an identical fingerprint and **no restart**, as long as the selected model set and order are unchanged. Content-diff-and-skip then makes re-applying free. **Preserve this property; do not "helpfully" start writing metadata into provider objects.**

One related tripwire: `EXPECTED_PROVIDERS = 44` (`run.mjs:32`) is an equality check. Once a
refresher is live, a revoked key or a genuinely vanished provider makes keysync fail
validation outright rather than degrade.

## 6. Locking

The refresher must **not** take the keysync lock (`safety.mjs:162`). Sharing it means a slow
120 s fan-out can block a keysync run the user is sitting in front of, and it conflates two
different critical sections: keysync's lock protects *CCR's config and settings.json*; the
refresher touches neither.

Give the refresher its own `catalogue.lock` with the same `wx` + PID-liveness semantics —
that code is correct, including the `EPERM`-means-alive subtlety (`safety.mjs:210-216`), so
copy it rather than reinventing it.

The refresher-vs-keysync race is then solved **without a shared lock at all**, by the
`current` pointer: keysync resolves `current` once at startup and reads only inside that
snapshot dir. A concurrent refresh builds a different dir and flips the pointer atomically at
the end. keysync's read is always of a consistent, immutable snapshot. **Strictly better than
a mutex** — no blocking, no lock ordering, no way for a hung refresher to wedge an apply.

The one ordering rule: **the refresher never invokes keysync.** A "refresh then apply"
convenience is a wrapper script that takes the keysync lock itself and runs them in sequence
— never a callback from inside the refresher.

---

## What NOT to build

- **No SQLite.** CCR's `config.sqlite` is already a restart-coupled liability needing WAL-safe `VACUUM INTO` and DPAPI to handle safely. 44 small JSON files under a snapshot pointer is the right weight.
- **No long-running refresher daemon.** A third supervised process is a third thing that can wedge.
- **No auto-apply, ever.** A background job that reconfigures CCR is the 2026-09-01 outage on a timer.
- **No scheduled Tier C.** The only genuinely expensive operation stays behind a human.
- **No picker growth.** 89 rows was already measured near-unusable, and `MAX_MODELS_PER_PROVIDER = 3` is the load-bearing constraint keeping it survivable. If the goal is browsing 4,298 models, that is a separate UI reading the snapshot directly — **not more `modelPicker.options`.** Conflating them is the main design mistake available here.
- **No writes into `providers.json`.** It is human-curated and its `notes` carry trust judgments an automated refresher cannot reproduce or defend.

## Expected failure modes

1. **Upstream schema drift** (models.dev renames a field) → clean 200, empty parse, looks like mass deletion. *Caught by the per-provider shrink guard.* **The most likely real failure.**
2. **GitHub raw / models.dev outage** → all-zero snapshot. *Caught by the 80% floor.*
3. **Rotated key** → 401. Must classify `hard`, flag the provider, and **not** touch its models. Failing to separate this from `soft` rebuilds the ratchet.
4. **Selection instability → gratuitous restart.** Fixed by the `localeCompare` tiebreak.
5. **Refresher hangs on one provider** → run never completes, `current` never flips, lock held. *Caught by the 120 s hard-abort plus PID-liveness lock reclaim.*
6. **`--verified-only` against a months-old `verified-rows.json`** → ships a picker reflecting long-gone conditions. Add an age refusal.
7. **`EXPECTED_PROVIDERS = 44` fires on normal operation** once provider churn is routine.

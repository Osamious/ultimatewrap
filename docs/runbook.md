# UW runbook

What UW is, how its pieces fit together, and the commands you actually run.

## 1. What UW does

UW ("UltimateWrap") lets Claude Code route through as many working models as
possible — the Anthropic subscription relay plus dozens of third-party
providers — through a local [CCR](https://github.com/musistudio/claude-code-router)
gateway, while picking the model from inside Claude Code itself (`ctrl+g`)
instead of editing config by hand.

Three moving parts, each with one job:

| Piece | Job |
|---|---|
| **`~/.llmkeys`** (the vault) | Every API key, which provider it belongs to, and how to call that provider. Outside this repo, never committed. |
| **`keysync`** | Reads the vault + a model catalogue, builds CCR's provider config and Claude Code's model picker list, and applies both. |
| **`menu`** (the picker) | A terminal TUI that opens inside Claude Code's `ctrl+g` handoff, reads a pre-built snapshot, and writes back the model you chose. |

Nothing here mutates CCR's own npm package or Claude Code's own binary. UW
only ever writes: `~/.llmkeys/*`, `~/.uw/*`, CCR's `config.sqlite` (via its
own admin API), and (only with `--target live --i-know`) the real
`~/.claude/settings.json`.

## 2. The vault (`~/.llmkeys`)

Three files, outside the git repo:

- **`registry.json`** — one row per key: `{id, provider, bucket, tier, envVarName, notes, added}`. `id` is `bucket.provider.tier`.
- **`providers.json`** — one row per provider: base URL, protocol (`openai`/`anthropic`/`generic`), header template, test model, pricing/notes.
- **`key-choices.json`** — which key wins when a provider has more than one (see §5).

Secret values never touch either JSON file — they live encrypted in Windows
Credential Manager, keyed as `LLMKEY:<id>`. `ApiKeyVault.ps1` (dot-sourced by
everything that needs a secret) is the only code that reads or writes them.

## 3. The pipeline, end to end

```
~/.llmkeys (vault)  +  catalogue (CCR bundle or local copy)
        │
        ▼
   keysync/keysync.mjs   -- pure builder: vault + catalogue -> {providers[], picker[]}
        │
        ▼
   keysync/run.mjs        -- validates, then applies
        │
        ├── --dry                build + validate, write nothing
        ├── --target isolated    apply to a throwaway CCR instance (safe to break)
        └── --target live --i-know   apply to the REAL CCR + ~/.claude/settings.json
```

`run.mjs` is also what regenerates Claude Code's `modelPicker.options[]` (the
`/model` list) and CCR's `Providers[]` (what the gateway actually routes on).
These are two different arrays built from one candidate set — see
`test/routing-split.test.mjs` if you ever wonder why a provider appears in one
but not the other.

## 4. Everyday commands

```powershell
# See what a run would do, without touching anything.
node keysync/run.mjs --dry

# Apply to the real CCR + Claude Code settings (only after you've read the --dry output).
node keysync/run.mjs --target live --i-know

# Same, but refuse (writing nothing, no backups) if the change would restart the gateway.
# Use this for any apply you don't want to be able to interrupt running sessions.
node keysync/run.mjs --target live --i-know --no-restart

# Rebuild the picker's pre-rendered row set (menu/uwpick reads only this file, never the vault live).
node menu/snapshot.mjs --build

# Environment sanity check: editor wiring, HUD shim, CCR reachability, etc.
node menu/doctor.mjs
```

**Picking a model in Claude Code:** type `m` (or `model`, or `>>m`) into the
chat box, then press `ctrl+g`. That opens the UW picker inside Claude Code's
own external-editor handoff. Anything else typed before `ctrl+g` passes
through to your real `$EDITOR` untouched.

**Installing/repairing the `ctrl+g` wiring and the optional HUD statusline:**

```powershell
. C:\Users\osami\.uw\menu\install.ps1              # wire ctrl+g to the picker
. C:\Users\osami\.uw\menu\install.ps1 -Hud          # also install the statusline shim
. C:\Users\osami\.uw\menu\install.ps1 -HudUninstall # remove the statusline shim
```

## 5. Key lifecycle — adding, testing, removing, and choosing among keys

Load the vault helpers once per PowerShell session:

```powershell
. C:\Users\osami\.llmkeys\ApiKeyVault.ps1
```

Then, day to day, prefer the Node CLI (`keysync/key.mjs`) over calling the
PowerShell functions directly — it re-checks the real ambiguity rule
(`filterRegistry` + `chooseKeys`) after every change, so you find out
immediately if a new key needs a deliberate choice recorded:

```powershell
# Add a key (prompts for the secret value on your real terminal, then test-calls it).
node keysync/key.mjs add <bucket> <provider> <tier> --notes "optional note"

# Remove a key by id. Also clears any dangling key-choices.json entry pointing at it.
node keysync/key.mjs remove <bucket>.<provider>.<tier>

# List every key in the vault.
node keysync/key.mjs list

# Re-test one key's credential live.
node keysync/key.mjs test <bucket>.<provider>.<tier>

# Record which key wins for a provider that has more than one (no add/remove involved).
node keysync/key.mjs prefer <provider> <bucket>.<provider>.<tier>
```

**Why "prefer" exists at all:** if a provider ends up with two or more usable
keys after filtering, `keysync/run.mjs` refuses to guess which one should
route — it throws, naming the provider and every candidate id, rather than
silently picking whichever key happens to sort first. `prefer` (or the
prompt `add` shows you automatically when it creates the ambiguity) is how
you resolve that, once, by name. The choice lives in
`~/.llmkeys/key-choices.json` and survives key rotation.

If you ever add a provider profile with `Set-ProviderProfile` directly in
PowerShell instead of through `key.mjs`, run `node keysync/run.mjs --dry`
afterward — that's the same check `key.mjs` runs for you automatically.

## 6. Phase B — catalogue refresh and health

Three independent refresh actions. None of them run on a schedule; every one
is a deliberate, manually-invoked command by design (a scheduler that
supplies its own "yes, do this" on every tick turns a safety gate into a
constant "yes").

### 6a. Catalogue insulation — keeping the model list off `node_modules`

`keysync.mjs` reads the model catalogue through a local flat copy at
`~/.uw/catalog/models.json` when one exists, falling back to CCR's own
bundled copy (inside `node_modules`, which a global `npm i -g` can silently
replace or delete) with a visible warning if it doesn't.

```powershell
# Copy CCR's current bundle out to the local, insulated copy.
node refresh/catalog-store.mjs
```

Run this after any CCR reinstall/upgrade, or whenever `keysync/run.mjs`'s
output shows a `catalog-store: no local copy ... falling back to ...`
warning.

### 6b. Provider listing discovery (tier 2) — what ids a key can actually call

```powershell
# Dry: shows the resolved listing URL (or refusal) for every provider. Makes no request.
node refresh/cli.mjs

# Same, scoped to specific providers.
node refresh/cli.mjs --only groq,agentrouter

# Live: one authenticated GET /models per provider, writes the discovery cache
# keysync.mjs reads on every run.
node refresh/cli.mjs --live
```

`--live` is real, authenticated traffic against every provider in the vault —
that's why it's never the default and never scheduled.

### 6c. Health — probe results feeding the snapshot's `health` field

> The picker no longer draws a health column: the provider list shows a three-state `status`
> (alive / down / dead) and benchmark counts (6d). The `health` string is still resolved and
> stored on every snapshot row for other readers, and everything below still applies to it.

The snapshot's `health` field (`ok` / `needs $` / `broken` / `stale`) is
resolved from `~/.uw/state/health.json`, which is folded from a probe results
file — not derived live from vault notes alone. Fold whatever probe file you
have (the shape is `{at, results: [{id, state, ...}]}` with
`state ∈ ok|auth|broken|skipped`):

```powershell
node -e "import('./refresh/health-writer.mjs').then(m => console.log(m.writeHealthFromProbeFile('./keysync/key-health-latest.json')))"
```

Then rebuild the snapshot so the picker picks up the new health values:

```powershell
node menu/snapshot.mjs --build
```

**What the four health states mean**, and why `stale` is not a failure:

| State | Meaning |
|---|---|
| `ok` | A real probe (or an authenticated listing call) answered inside the last 14 days. |
| `needs $` | The provider profile is marked `requiresBalance` and nothing is broken. |
| `broken` | 3+ consecutive probe failures, or a hand-written note says so. |
| `stale` | Nobody has measured this provider recently enough to say — **not** the same as broken. A green `ok` from three weeks ago would be a claim nobody re-checked, which is worse than showing `stale` honestly. |

A probe verdict is never downgraded by a later, weaker signal (a listing call
proves a key authenticates; it does not prove a completion actually works,
so it can never overwrite a probe's `broken`).

**Not yet wired:** an automatic per-refresh health projection (so `--live`
discovery runs would update health.json on their own). Today, health only
updates when you run the fold command above by hand. This is a deliberate,
tracked deferral, not an oversight.

### 6d. Bench — measured speed per model (always-on columns in the picker)

Every model list in the picker (a provider's models, and flat scope) shows, next to
the catalogue columns, per model: **status, TTFT, total time, tok/s and a preview of
the reply**. There is no toggle (the old `^b` bench view is gone and `^b` does
nothing): it is one view, with every column shown when the terminal is wide enough.
The columns read `state/bench.json` **lazily, once**, the first time a model list is
drawn, never at startup and never while only the provider list is used. The numbers come from one
real streamed chat request per model, sent **through the CCR gateway** (the path
a real session takes), so they include routing overhead.

```powershell
# Dry (default): the plan — rows, providers, free/paid split, spend, wall time. Sends nothing.
node refresh/bench-cli.mjs

# Live: probe every routable text row, the probe-all way (below). Real requests, so
# never the default and never scheduled. `--probe-all` is accepted and does nothing.
node refresh/bench-cli.mjs --live

# Opt in to the old budget and breakers: skip dead/unfunded providers, $0.01 a row, $2 total.
node refresh/bench-cli.mjs --live --economy

# A sample (round-robin, so every provider's first row is in it) or specific providers/models.
node refresh/bench-cli.mjs --live --limit 40
node refresh/bench-cli.mjs --live --only aihubmix,openrouter/some-model

# Fold an interrupted run's log into bench.json without probing.
node refresh/bench-cli.mjs --compact

# Re-probe exactly the rows in a list (one provider/id per line, # comments; combinable with --only).
# The study's lists are in plans/bench-study/lists/ (regenerate: node plans/bench-study/scripts/make-lists.mjs).
node refresh/bench-cli.mjs --only-file plans/bench-study/lists/empty55.txt --force --max-tokens 1024
node refresh/bench-cli.mjs --only-file plans/bench-study/lists/timeout42.txt --force

# One-shot maintenance: redact provider text already stored (refuses while a sweep runs).
node refresh/bench-cli.mjs --redact

# One-shot maintenance: turn `ok` records whose reply is really an error/account notice into auth/pay/error.
# --dry previews the change and writes nothing; the plain run takes the sweep lock (refuses under a running sweep).
node refresh/bench-cli.mjs --reclassify-notices --dry
node refresh/bench-cli.mjs --reclassify-notices
```

What a live run does, so its cost is predictable:

- **Scope:** every routable, text-output row in the snapshot (~5,800). Rows
  measured in the last `--ttl` days (default 7) are skipped, so a re-run resumes;
  `rate`, `timeout`, `error` and `skip` results are always retried. `--force`
  re-probes everything.
- **Concurrency:** 8 in flight overall, 2 per provider, round-robin across
  providers, one canary probe per provider before the rest (chat-looking models
  first: moderation, embedding and "labs" ids go last). A 429 pauses only that
  provider, honouring a usable `Retry-After` (seconds or an HTTP date); with none, or a
  `0`, it backs off 1 s, 2 s, 4 s ... (max 60 s), so a provider answering 429 without a
  header is never hit again at once.
- **Per-probe timeout: 240 s (`--timeout`, both modes).** Slow models and gateways get four
  minutes; the price is that a provider whose rows all hang can take hours, so
  **`--max-minutes` (150 by default) is the real backstop**: the plan prints the
  worst case next to it. Nothing waits out a hung probe: Ctrl-C, the wall-clock stop and
  a confirmed gateway outage each abort the probes in flight (dropped, not recorded,
  re-probed on the next run), and a probe sent before an outage that only fails after it
  began is put back rather than recorded. A timed-out row is **not retried** (it already
  waited the whole deadline; an `error` still gets its one retry). A timed-out record stores
  `d` = the deadline (the picker shows `240s`) and stays transient. Because 30 consecutive failures can take a
  quarter of an hour to arrive at 240 s each, a full timeout plus a minute with not one
  `ok` anywhere also triggers the gateway check. `--economy` keeps the 240 s (its
  breakers already stop a hanging provider after three failures) but has no wall-clock
  limit unless you add `--max-minutes`.
- **Probe-all is the default: no provider is skipped.** Every row gets its own answer
  (the way to find every operational model), so a run is never followed by a second
  pass: no provider is ever recorded `skip:provider-dead` or `skip:unfunded`, however
  many of its models are refused or error. Politeness replaces skipping, to avoid key
  suspension or abuse detection: after `--cool-after` (default 10) consecutive
  `auth`/`pay`/`error`/`timeout` results with no `ok`, that provider drops to one
  request in flight with at least `--cool-gap-ms` (default 400) between dispatches, and
  returns to normal on its next `ok`, with no second attempt at a row that failed while
  cooled. `gone`, `rate` and `empty` neither count nor reset that run. Other providers
  are unaffected. A message that says the model does not exist or was retired is
  `gone`, so it is not retried, in two tiers: a 4xx (providers answer 400/422 for it)
  accepts the looser wordings ("no longer available", "retired", "invalid model",
  "is not supported"), while a **5xx accepts only the strong anchors** (`model_not_found`,
  "does not exist", "no such model", "unknown model", "Model not exist", a named or
  quoted model that is missing, removed or decommissioned), because 5xx texts like "model
  not found in KV cache" or "model was retired from pool, retrying" are transient faults
  of a working model. A sentence about a request parameter ("invalid model parameter")
  is never `gone`. Likewise a **5xx that merely mentions** billing, quota, payment, a
  purchase, a deposit or a recharge is a transient `error`, not `pay` (only words about an
  empty account count at a 5xx: balance, credits, top up, "requires a paid plan"); "Insufficient
  permissions" is `auth`; and a message that names the plan ("not found in your plan") is
  `pay` even on a 404. At a 5xx a sentence that carries a **transient marker** (retry, try again,
  temporarily, worker, pool, cache, shard, replica, queue, reload, capacity, rotation, node,
  region, unavailable) is never `gone` and never `pay`: "model 'x' was removed from the pool,
  retrying", "Insufficient GPU capacity" and "balance check service unavailable" stay `error`. "Insufficient"
  needs a money noun (credits, balance, funds, quota); "Invalid model output/format/parameter/type"
  is never `gone`.
  The status vocabulary is closed, so account state uses an existing status: "no longer
  available to new users" (google) and "free models are not available to this account
  yet" (orcarouter) are `auth` (the account is refused, the model exists); an empty
  balance in words ("Insufficient credits ... top up") is `pay` even on a 429 whose body
  also says rate limit; "cannot be served at the moment" and the gateway's opaque
  "Upstream request failed." stay `error` (or the status the HTTP code names: 402
  `pay`, 404 `gone`, 401 `auth`), with the sentence kept in `m`.
  A run also stops itself after `--max-minutes` (default 150) and resumes where it left off.
- **`--economy` (opt-in) restores the old budget and breakers** (the engine underneath is
  the current one: token-based billing, worst-case admission, the outage hold, exit
  codes 3 and 4): a provider that gets three
  consecutive refusals with no success (`auth`, or `pay` on a free row) or three
  consecutive errors is marked dead and its remaining rows are recorded `skip` with
  **no further requests**; five consecutive `pay` results on paid rows stop that
  provider's paid rows. The defaults go back to $0.01 a row, $2.00 total and no
  wall-clock limit, and there is no cooling. Use it for a cheap first look; a
  later default run re-probes every `skip`. The picker's provider `status` ignores `skip`
  records (they are not probe results); the default probe-all mode records none.
- **A dead gateway is not a provider failure** (both modes). Every live run watches for
  it: after `--outage-after` (default 30) consecutive final `auth`/`pay`/`error`/`timeout`
  results with no `ok` anywhere, it checks the gateway's `/health`. If it is down, the
  run pauses, the rows it hit are put back **unrecorded** (not logged as errors),
  it polls every 10 s, and it resumes when the gateway answers. After
  `--outage-wait-min` (default 10) down it stops like Ctrl-C (exit code 4) and a re-run
  picks those rows up.
- **Spend caps:** `--max-spend` (default $5.00 across the run; $2.00 under `--economy`)
  and `--max-row-cost` (default $0.10 per row; $0.01 under `--economy`; judged on the
  worst case at the full 96-token budget). Explicit flags always win over either
  mode's default. Rows over the ceiling are recorded `skip` (`row-cost`), and paid rows
  past the cap `skip` (`spend-cap`). A row being retried faces the cap again (a cap
  leak: retries used to bypass it, and a $2.00 cap reached an estimated $2.12; a retry
  that no longer fits is recorded `skip:spend-cap`). **The cap is an estimate, not a
  hard bound on the invoice**: each probe is charged from the output tokens the
  provider reported (a timeout at its worst case), and each probe in flight holds its
  worst case (the full `max_tokens`) until it finishes, so concurrency cannot push the
  estimate past the cap. A row that fits only until those holds are released waits
  instead of being skipped. Refused or errored requests (401/402/404/5xx) are normally
  not billed; a stream that fails after tokens flowed can be, and is charged when
  reported. The dry run says which mode it is (`probe-all (default)` or `economy`),
  prints both the typical-answer estimate and the worst case (every paid row at full
  `max_tokens`), and when the cap can bind says it cuts the late, expensive rows (paid
  rows are queued cheapest-first within each provider). It lists the costliest rows
  over the ceiling, and a finished run prints how many rows remain unprobed and why,
  by count (`row-cost`, `spend-cap`). Re-run to resume; skips are always re-probed.
- **One sweep at a time.** A live run holds an exclusive lock file
  (`~/.uw/state/bench.lock`: pid, start time, mode). A second `--live`, or a
  `--compact` while a sweep runs, is refused (`another sweep is running (pid N since
  HH:MM); nothing was sent`, exit code 5) before anything is sent or written, and the
  dry plan says so too. A lock whose process is gone, or that outlived its
  `--max-minutes` plus 10 min, is taken over with a printed notice; it is released on a
  normal finish, Ctrl-C, an outage stop and an uncaught error. A `bench-cli.mjs --live`
  process started before the lock existed is looked for through the OS (best effort)
  and blocks a new run as well. The cap and ceiling are **per invocation**: a resumed
  run starts with a fresh budget, and the plan prints what the answers already on
  record would have cost (an estimate from the latest record per model).
- **Runaway streams are cut (`--stream-cut N`, default 4 x `--max-tokens` = 384; 0 = off).**
  Many reasoning models ignore `max_tokens: 96` and stream thousands of tokens over minutes
  (measured: 7,559 tokens over 163 s). The probe needs only the first token, a preview and a
  rate, so once a stream is past the allowance the request is aborted and the row recorded
  as the `ok` it is, with the marker `x: 1`; `o` is then the larger of the provider's own
  count (if it arrived) and characters / 4, never below the allowance (an estimate: that is
  what `x` says), and `r` is computed over the window seen before the cut. Nothing is cut
  before the first content delta, and `empty` is unchanged. The cut allowance is also the
  ceiling on what one probe can bill: `--max-row-cost` and the in-flight reservation use it. The token
  estimate counts a CJK, kana or Hangul character as about one token (other text as chars / 4). A stream
  `error` event that arrives AFTER content keeps the row `ok` (its first-token time is real) and records
  "stream error after first token: ..." in `m`. Readers get the cut marker as `x` on the record from `loadBench`.
  Rows whose worst case at the 4x allowance exceeds the ceiling are recorded `skip:row-cost` and keep their
  earlier records (empty55 at `--max-tokens 1024`: o1-pro, o1-pro-2025-03-19, o1, o1-2024-12-17, gpt-5-pro);
  probe them with `--stream-cut 1024` (or `--max-row-cost 3`).
- **Unpriced rows** (no catalogue price) are charged a documented conservative price on the
  tokens the probe saw: $0.60 in / $3.00 out per million (printed in the plan). The old flat
  guess, scaled linearly by tokens, made a 7,559-token unpriced answer cost about $0.78
  instead of about $0.02 and turned a $0.06 plan into a $5.24 estimate. Unpriced rows are probed AFTER the
  priced rows of their provider (an unknown cost goes last), and the plan states how many there are and that
  their cost is an assumption.
- **A 200 that is really a notice is not an `ok`.** If the WHOLE streamed text (short, and not
  greeting-led) reads as an error or account notice ("The account behind this API key
  doesn't ..."), the row is `auth` (account/key wording), `pay` (credit/balance/quota
  wording), `rate` ("Rate limited", "Too many requests"), `gone` ("Model not found") or `error`, with the
  sentence in `m` (all 106 pollinations `ok` rows were this). Any text that says "hello" is never a notice;
  the wordings are English only, added when a real provider notice plausibly starts that way.
  Records written before that rule existed are fixed once by `--reclassify-notices` (bench.json
  and the log; `t`, `r`, `o` and `k` are dropped, `a`, `d`, `p` kept, `m` = "reclassified from ok
  (HTTP 200 notice): ..."; idempotent; combines with none of `--live`, `--compact`, `--redact`).
- **Empty filters never widen a run.** `--only` / `--only-file` with no usable entry is an
  error, and an empty list selects nothing. An `--only-file` that contributes no probeable row is an error
  even beside `--only`; when both contribute, the selection is their union and the plan prints both counts.
- **Start-up health gate:** the first `/health` call gets 10 s and one retry after 2 s
  before the run refuses to start ("the gateway is not answering; nothing was sent").
- **Exit code:** 0 for a normal outcome or a Ctrl-C; 3 when probes were sent and not
  one model answered `ok` (check the gateway and the keys); 4 when the gateway never
  came back; 5 when another sweep is running.
- **Ctrl-C** stops scheduling, **drops the probes still in flight** (they are not
  recorded and are re-probed on resume), saves what finished and compacts; run again
  to resume. A second Ctrl-C exits immediately (the log is still on disk and
  `--compact` recovers it).
- **Files:** `~/.uw/state/bench.jsonl` (append-only checkpoint) is folded into
  `~/.uw/state/bench.json` (latest record per `provider/id`, about 120 bytes/row, plus
  the provider's own message `m` on a non-ok one). **The stored reply preview `p` is
  120 characters** (`PREVIEW_CHARS`; it was 40): the head of the answer on an `ok`, the head
  of the provider's sentence otherwise (a non-ok record whose `p` is just the first 120
  characters of its `m` stores only `m` and derives `p` on load). **Records written before
  the change keep their 40-character previews until they are re-probed.** Measured for 6,000
  records: about 0.76 MB typical, 1.37 MB with a third of the rows at a full 120-character
  preview and the rest at the 160-character message cap, 1.30 MB with every row an answer at
  120 characters (the size test asserts under 1.5 MB / 2 MB). "Latest" has one exception: a
  transient result (`rate`/`timeout`/`error`/`skip`) never replaces an older real one
  (`ok`, `empty`, `auth`, `pay`, `gone`) that is still fresh (14 days, or `--ttl` if
  longer), so a `--force` run in a flaky hour cannot erase a good measurement. Only what
  compaction keeps changes; the log still records every result. **Provider text is
  redacted** before it is stored and again when loaded (`m` and the head of a non-ok
  `p`): masked or elided key fragments (`7f3a9c*****e21d`, `sk-abc••••wxyz`,
  `sk-abcd...wxyz`), key shapes (`sk-`, `hf_`, `gsk_`, `Bearer`, JWTs whole, `api_key=` and
  JSON-quoted secrets, letters-only ones included), URLs, e-mail addresses and opaque
  request ids (`req_...`, UUIDs) become `[masked-key]`, `[key]`, `[url]`, `[email]`,
  `[id]`, and the readable sentence stays. `--redact` applies this once to an
  existing `bench.json` (and a non-empty log); it takes the sweep lock, writes atomically
  and prints how many records changed. It is idempotent: run again after the rules grow,
  it only changes records the new patterns newly match. A probe sent with a non-default `--max-tokens`
  stores that budget as `b` on its record, so a 1024-token `ok` is not read as a
  96-token one (nothing reads `params.maxTokens`, which stays the 96 default). A
  `--force` re-probe of an `empty` that now answers replaces it; a newer `error` or
  `timeout` does not overwrite an older `empty`. For re-probes of a list, note that
  the plan's dollar *estimate* assumes a typical short answer, but the routes in
  `empty55.txt` spend their whole budget: read the **worst case** line for them, and
  rows whose worst case at the larger budget exceeds `--max-row-cost` are recorded
  `skip:row-cost` (at 1024 tokens: openai o1-pro, o1-pro-2025-03-19 and gpt-5-pro; raise
  `--max-row-cost` to 0.65 to include them).
  Neither is part of the catalogue snapshot, so a snapshot rebuild never discards a
  sweep. (A rebuild *reads* `bench.json` to count, below; it never writes it.)
- **History backups.** `bench.json` keeps one record per model and every run overwrites
  it, so a route that was `ok` and later returns `gone` would lose its evidence. Every run
  that writes `bench.json` or its log (`--live`, `--compact`, `--redact`, a real
  `--reclassify-notices`; never a dry run) first copies the current `bench.json` to
  `~/.uw/state/bench-history/bench-<UTC yyyymmddThhmmssZ>.json` and prints
  `bench: history saved -> ...`. **The copy is always redacted** (every record goes
  through the same provider-text redaction as compaction, so a `bench.json` written
  before redaction existed cannot leak a key fragment into history; measurements and
  statuses are untouched; the copy is content-identical, re-serialised as compact JSON,
  so identical for files the tool wrote). It
  saves `bench.json` only, not an unfolded `bench.jsonl` log: the sweep's end-of-run
  compaction folds the log into `bench.json` later, and the next run's copy has it. A
  copy identical to the newest one is not repeated (`history unchanged`). At most 30
  copies are kept (about 1 MB each), the one just written always among them;
  `--keep-history N` changes that (at least 1: there is deliberately no way to turn
  history off). Older copies are pruned by name, and only files named
  `bench-<stamp>.json` (plus the `.tmp-*` debris of an interrupted write of one) are ever
  touched. No `bench.json` yet is a quiet `history skipped`; a real failure prints one
  warning and never stops the run. `state/` is gitignored, so none of this is
  committed. It is a safety net you read by opening a file, not a queryable history (an
  ever-`ok` ledger is a separate, later item).
- **The sweep ends by rebuilding the snapshot.** After the end-of-run compaction, and
  before it releases the sweep lock, a `--live` run that changed `bench.json`'s records
  (finished, or stopped by Ctrl-C or the time limit; a run whose only results were
  transient ones that older real records outrank changes nothing and does not rebuild)
  runs `node menu/snapshot.mjs --build` itself as a background child process (5 minute
  limit) and prints one line,
  `bench: snapshot rebuilt (<N providers, M models, catalogue ...; routability: ...>)`.
  When the gateway is up and the vault registry, providers and catalogue files exist,
  `node refresh/bench-cli.mjs --live` alone therefore brings both picker levels up to
  date: the rebuild recomputes the bench counts and flags from `bench.json`, and also
  re-stamps routability and re-fetches the relay catalogue, exactly as the manual
  command does. **A rebuild during a gateway outage would degrade routability, so it is
  skipped**: when the sweep gave up on a dead gateway, or `/health` does not answer right
  before the build, the run prints `bench: snapshot not rebuilt (gateway not answering);
  run: node menu/snapshot.mjs --build when it is back`; and a build whose output says
  routability was unknown is reported as a warning
  (`snapshot rebuilt WITHOUT routability`), not as success. A run that recorded nothing,
  a dry run and every read-only path do not rebuild. A failed rebuild never fails the
  sweep or changes its exit code: it prints one
  `bench: warning: snapshot not rebuilt (<reason>); run: node menu/snapshot.mjs --build`
  line on stderr. Ctrl-C during the rebuild kills the child (the exit code stays as
  decided); a second Ctrl-C exits at once. The manual rebuild is needed only after the
  other bench writers (`--reclassify-notices`, `--redact`, `--compact`, which do NOT
  rebuild), after a catalogue change, or after a skipped or failed rebuild. There is no
  flag to turn the rebuild off.

**How to read it.** TTFT is request-sent → first streamed token; total is
request-sent → stream closed; tok/s is provider-reported output tokens divided by
the generation window, shown `-` when the reply was too short to measure (never
estimated). A blank row means *not benched*, not zero. `empt` means no text came
back — most often a reasoning model spent all 96 tokens thinking (raise
`--max-tokens` to see its answer; a `~` in the preview marks reasoning text shown
because no answer arrived). **The probe is a bare chat message with no tools**, so a
model can pass it and still fail a real Claude Code session (tool schemas, large
prompts). It is one sample taken under sweep load: read it as a ranking.
`--only provider/model` re-probes one row in isolation.

**The model list.** One view, left to right: provenance gutter, id, `stat` (the probe
status), `ttft`, `total`, `tok/s`, `ctx`, `$in`, `$out`, `badge`, `modality`, `TVR`,
`output`. The `limit` column is gone (it only ever showed `?`). The id column is only as wide as the provider's longest id (capped at 40;
longer ids are elided in the middle), so the other columns sit beside it, and what is
left over is empty space at the right. The id keeps at least 22 columns before any
optional column is dropped. Narrow terminals drop columns in a fixed order: `output`
first, then `tok/s`, then `total`; `modality` is always drawn, so it outlasts all three; the id
grows toward its full width only once every column that fits is showing. At 80 columns you
get id (22, its floor), `stat`, `ttft`, `ctx`, `$in`, `$out`, `badge`, `modality`, `TVR`; `total`,
`tok/s` and `output` do not fit (a short id, about 10 characters, still leaves room for
`total` and `tok/s`). **Every column shows from a 103-column terminal** (101 when the
longest id is 20 characters or fewer), with the id at 22 columns; a wider terminal
first lets the id grow to its content, then widens the preview. Prices are at most
five columns (`180.0` above 100, whole numbers above 1000).

**Cut and broken streams.** A record with `x` (the probe cut the stream of a model that ignored
`max_tokens`) has no honest `total`, which would be the time to the cut: that cell is blank, its
`tok/s` is an estimate over the part seen and draws with a leading `~` (`~56`), and the `reply:` line
starts `[cut]`. An `ok` record carrying `m` (a stream error after the first token) keeps its cells and
its `reply:` line starts `[stream error]` followed by the message in parentheses.

**The `modality` column** is what the route outputs, as one word, decided when the snapshot is
built (`node menu/snapshot.mjs --build`) from the best positive evidence, in this order: the
provider's own capability token from the discovery listing (`listing`); the catalogue entry's
LiteLLM `mode` (`mode`); the entry's `modalities.output` when it names ONE modality
(`output`); an `outputKind` of `nontext` with nothing more (`kind` -> `other`); and last, a
fresh `ok` probe with no other evidence (`bench-ok` -> `chat?`). The words are `chat`,
`chat?`, `image`, `audio`, `video`, `embed`, `rank`, `mod`, `stt` (speech to text), `ocr`,
`live` (a realtime voice model) and `other`; **`?` means unknown and is never a guess**. The
listing outranks the catalogue for the same reason `outputKind` does (a live `image` demotes a
bundle entry that says `text`), so the two labels cannot contradict each other. Nothing comes
from the id, and a failed probe (for example `not a chat model`, `/v1/chat/completions`) is
never used: it says the request failed, not what the model is. A mixed output list
(`audio` + `text`) is not treated as primary evidence. A route the picker already treats as not-chat
(`outputKind` `nontext`, which dims it and shows `nochat` in `ctx`) is never labelled `chat`: a rung that
would say so is skipped, and the next rung, or `other`, decides. The column is 8 wide (the size of its header; the words are at most 5), left-aligned like
the badge. Every known word has its OWN colour (table below, one source of truth in
`menu/modality.mjs`; decoration only, the word carries the meaning) and `?` (unknown) is dim.
On a 16-colour terminal the ANSI 8+8 colours are used (some words share a hue with a bright variant),
and with no colour the word alone is drawn. The words:

| word | 256-colour | hue | 16-colour (SGR) |
|---|---|---|---|
| `chat` | 40 | green | 32 green |
| `chat?` | 79 | aquamarine | 36 cyan |
| `image` | 201 | magenta | 35 magenta |
| `embed` | 208 | orange | 33 yellow |
| `video` | 196 | red | 91 bright red |
| `audio` | 226 | yellow | 93 bright yellow |
| `stt` | 33 | azure blue | 94 bright blue |
| `live` | 51 | bright cyan | 96 bright cyan |
| `rank` | 141 | lavender | 95 bright magenta |
| `ocr` | 213 | pink | 31 red |
| `mod` | 190 | yellow-green | 92 bright green |
| `other` | 250 | light grey | 97 bright white |
| `?` (unknown) | dim | not a type | dim |
 The snapshot stores it as `outModality` (always present, `null` when unknown) and the
deciding source as `outModalitySrc` (present only when known); both arrived with snapshot
schema 7 (a schema-6 file is rejected and rebuilt rather than drawn with blank `status` and `?`); the
provider `status` became three-state in schema 8. The existing `modality` field is unchanged: it
is still the listing's raw capability token. On the real 2026-09-29 data (6,032 routes) this
gives: `chat` 3,672 (`mode` 2,097, `output` 1,346, `listing` 229), `chat?` 628 (`bench-ok`),
`image` 106, `embed` 87, `video` 44, `audio` 33, `stt` 31, `live` 20, `rank` 11, `ocr` 9,
`mod` 6, `other` 5, and `?` 1,380 (22.9%; every one of those has only failed probes).

A long id is **elided to keep what differs**: for each provider the picker picks the
head/tail split that leaves the fewest rows drawing an identical cell (then re-splits
any group that still collides), so `gemini-3.6-flash:batch` and `...3.8...` stay
distinguishable; in flat scope the `provider/` prefix stays whole whenever the model
part alone can be made distinct. Measured on the real snapshot (terminal 80 / 90 /
101 / 110 / 134 columns), rows drawing a cell shared with another row went from
22 / 27 / 27 / 13 / 1 providers to 0 / 1 / 1 / 0 / 0 in a provider's list, and in flat
scope from 644 / 1116 / 1116 / 227 / 26 targets to 84 / 188 / 188 / 5 / 0. The line
above the footer, `id: ...`, always shows the selected row's **full** id (level 1 the
model id, flat `provider/model`, provider list the whole key id) and is blank when the row cannot be selected; it costs one list row. On a model
list (and in flat scope) a second line, `reply: ...`, sits under it: the selected row's
full stored reply (or `skipped: <reason>`), sanitised, clipped with an ellipsis only at
the frame edge, blank for an unbenched row; it costs one more list row (the
reducer and renderer share `rowsAvail`, so no screen exceeds the terminal height). The
withheld-models overlay (`ctrl+r`) sizes its own id column (up to the longest
withheld id). Wide (CJK), emoji and combining characters are drawn as `?` in every
column so they cannot push a row past the frame; the underlying id is untouched.
The `K ok` figure on a model list is counted live from `bench.json`, so it always
matches the `benched` stamp and the `ctrl+o` list; the provider list keeps the
snapshot's counts. The output column takes all the width that is left (the frame
follows the terminal up to 260 columns): the stored reply, not the layout, limits it.

Four toggles: `ctrl+o`, `ctrl+l` and `ctrl+e` apply to model lists only (they do nothing at the
provider list); `ctrl+x` works at BOTH levels. All are toggles, default off, one shared flag each
(so they survive going back a level, opening another provider or switching to flat scope), they
combine with each other and with typed text (logical AND), and the header shows a chip for each
(`[ok]`, `[1M+]`, `[no gone]`, `[free]`):

- `ctrl+o` **ok-only**: only models whose latest bench status (a record of any age)
  is exactly `ok`. Unbenched, `empt` and `pay` models are out. With no
  bench data at all the list is empty and says so.
- `ctrl+l` **1M+**: `ctx >= 1,000,000` **or** an id ending in `[1m]` (any case).
  Both are needed: in the real catalogue 1,062 ids carry the tag, one of them
  (`teamorouter/kimi-k3[1M]`) with a null ctx, and two reach 1M without the tag.
- `ctrl+x` **no gone**: on model lists and in flat scope it hides every model whose latest *fresh*
  bench record is `gone` (the route is not found upstream); a route with no fresh record is shown
  and a `gone` record hides whatever its age. **On either level it also changes the percent figures**:
  the provider list's `ok` `%` and both headers' `K ok (P%)` are ok / models while the toggle is
  off, and ok / (models minus gone) while it is on (a zero denominator reads `-`). At the provider
  list it hides no provider row and leaves the cursor where it is; on a model list turning it on or
  off returns the cursor to the top. The `free` `%` is always over ALL models (a catalogue price
  fact) and the `ok` count, `models` and the raw `gone` column never change. Pure reducer toggle over
  the same lazily loaded bench data as `ctrl+o`. The chip `[no gone]` shows at both levels, `N of M`
  counts the filtered list, and the footer carries `[^x]gone`. (`ctrl+g` is not used: it is the key
  that opens the picker.)
- `ctrl+e` **free only**: keeps only models whose badge AS DRAWN is `FREE` or `FREE?`. A `FREE?`
  whose fresh probe said payment is required is already drawn with a blank badge (the snapshot
  blanks it), so it does not match. The provider list's `free` count is different: it counts the
  `FREE` / `FREE?` badges the catalogue gave at snapshot time, before that blanking, so the two can
  differ by exactly those rows. The chip is `[free]`. With all four chips on, the chip row shortens in
  two steps (packed, then `[1M]` and `[-gone]`) so the counts on the right are never clipped: at 78
  columns the left part (`filter:` plus the four chips) is 32 columns wide.

The header's right side is **counts only**: `N of M | K ok (P%)` on a provider
(N = models matching the filters, M = the provider's models, K = that provider's
models whose latest fresh bench result is `ok`, whatever the filters say, P = K as a
share of M while [no gone] is off, of M minus the fresh `gone` routes while it is on, counted
live from `bench.json`), `N of M models | K ok (P%)` in flat scope, and
`P providers | M models | K ok (P%)` on the provider list (the same two denominators, from the
snapshot's baked counts; while `[no gone]` is on the header total M is also all models minus
gone, and the % is over that shown total, e.g. 6,000 models and 1,146 gone read `4,854 models`;
the provider rows' own `models` and `gone` columns never change, so the header total can be
less than the sum of the visible `models` cells; on a model list `N of M` keeps the provider's
full M, so rows hidden by the toggle show as N < M); thousands take a separator from 1,000. `- ok` (a dash)
means nothing was benched, never `0 ok`: it is shown when the bench reader has no
records at all, and at level 1 also for a provider with no fresh record; `0 ok` appears
only when the provider has at least one fresh record and none is `ok`. The **data
stamps** (`routable`, `benched`, `discovered`) moved to the right end of the `id:` line
of the selected row: the fullest candidate that fits after the id is drawn, then the
next, else none, never a fragment. With no row selected there is no `id:` line and so
no stamps. The `id:` line also carries `= alias` (a working sibling of a `gone` route)
or `N plan` (plan-covered models) after the id when it fits.

**Baked versus live.** The provider list (level 0) is BAKED: its counts, verdicts and
its `(K ok)` total come from the snapshot and are as of the last `node menu/snapshot.mjs
--build` (the header's `bench MM-DD` is that date). Model lists (level 1 and flat scope)
are LIVE: their rows, `benched` stamp, `K ok` and the ok-only filter all read
`bench.json` on first draw. After a new sweep the two can therefore disagree (for
example `1396 ok` on the provider list and `1404 ok` in flat scope) until the snapshot
is rebuilt.

**The provider list's sweep columns.** Level 0 is, left to right: `key id`, `status`,
`oldest probe` (only when the terminal has room after the full key id), `models`, `ok` and its `%`,
`free` and its `%` (only when it has room after `oldest probe`), then seven raw
counts in this order: `empt`, `auth`, `pay`, `rate`, `gone`, `t/o`, `err`. The `dead`
and `needs $` *yes/no* columns, `skip`, `limit` and the health label are gone.

- `status` has three states over the provider's probe records (of any age; `skip` records
  are not probe results and are ignored):
  - **alive** (green): at least one fresh `ok` model.
  - **down** (yellow): at least one fresh record, none `ok`, and at least one answered: an
    `auth`, `pay`, `gone`, `empt` or `rate` result, a provider-side error body, or a timeout
    that returned a first token. The provider is reachable, nothing on it works right now.
  - **dead** (red): at least one fresh record and *every* one is a no-response: a
    `timeout` with no first token, or a transport-level `err` (`fetch failed`,
    `Failed to reach upstream provider`, `terminated`, a socket reset: the `NO_RESPONSE`
    pattern in `menu/route-hints.mjs`).
  - **blank**: no fresh record (a provider nobody benched has no verdict).
  It is a label only: routing never prunes a provider for reading `down` or `dead`. It is
  baked as `benchFlags.status` at snapshot build (schema 8); the older two-state
  `benchFlags.alive` (answered in any shape) stays in the file for other readers. On the real
  2026-09-29 data (57 providers): 42 alive, 15 down, 0 dead. The 15 down are the providers
  with no `ok` model at all (`pollinations`, `maestro`-`deepseek`, `gmicloudai`, `chutes`, `routllm`,
  `seekai`, `cerebras`, `sambanova`, `xai`, `tabiai`, `gorouter`, `indeedwebid`, `kiosapi`,
  `kktoken`, `justdowork`). The two-state version read all 57 as alive.
- `oldest probe` is the age of the provider's OLDEST probe record (the worst case, not the latest one: one
  stale model makes the provider read old), right-aligned in 12 under its lowercase header: `45m`, `5h`, `3d`,
  `12d`, `40d`. Whole minutes under an hour (`<1m` under a minute), whole hours under a day, whole days from a
  day; every unit rounds down (`59m`, then `1h`; `23h`, then `1d`; `47h` reads `1d`; `6d23h` reads `6d`). `-`
  means the provider has no probe record, blank means there is no bench data. It is coloured as a hint by how
  close the age is to the outdated threshold T = `BENCH_OUTDATED_DAYS` (7 days): **green** under 2/7 T (2d),
  **yellow** under 4/7 T (4d), **orange** under T (7d), **red** from T (7d) on; the bands are computed from the
  constant, never repeated. Orange is 256-colour 208, and bright red (91) on a 16-colour terminal (beside yellow 33
  and red 31); with colour off only the age text shows, which carries the whole meaning. The age is computed
  against the picker's own clock (fixed when it opens, so it does not tick while open) from an **age histogram**
  baked on each snapshot row (`benchAgeHist`, schema 9: `[[epochHour, count], ...]`, every status, the record's
  stamp floored to the hour), so it reads no `bench.json` at level 0. Because records are filed under the start of
  their hour, an age can read up to an hour older than the exact one (a record from 11:50 seen at 12:00 reads
  `1h`); once `bench.json` has been loaded (first model screen) its own histograms replace the snapshot's. The
  header is the full `oldest probe` (12 characters) and is never abbreviated: on a terminal too narrow for the
  column the whole column is off.
- `ok` and `free` are each two sub-columns, with no parentheses: the count (right-aligned in 4,
  `-` for zero, `2k` from a thousand; the `ok` count is drawn green, the `free` count blue) and the
  percent (right-aligned in 4: `50%`, `<1%`, `100%`, `-`; the header just says `%` over it). **The `ok`
  `%` is ok / models normally, and ok / (models minus gone) while `[no gone]` is on (`ctrl+x`, at
  either level; it hides no provider)**; a route never probed stays in the denominator and a zero
  denominator reads `-`. The `free` `%` is always over ALL the provider's models (a catalogue price
  fact), whatever the toggle says. The percent is nearest whole, but a non-zero count never reads 0% (`<1%`) and a
  partial count never reads 100% (it is `99%`). The percent is coloured by band as a hint: 70% and
  up green, 30-69 yellow, under 30 red, zero dim. The numbers carry the meaning without any colour.
  Blank is unknown (no bench data, or a provider with no free-tier data). The plan-covered count
  moved to the `id:` line (`N plan`).
- Each raw count is how many of that provider's models had that status on their latest
  probe, with no grouping. Every record counts whatever its age (there is no cutoff), so
  a model that was never benched is in **no** column and the counts can
  add up to less than `models`. A count cell reads `-` for zero and `2k` from a thousand up.
- **Pinned rows** (favourites `*` and recents) are drawn *above* the column header, closed
  by a dim rule, so the cursor starts on them and the table below stays aligned. With no
  pins there is no strip and no rule.

The frame is the terminal width minus two, clamped between a **78-column floor** and 260. So the
supported minimum is an 80-column terminal: on a narrower one the frame is wider than the terminal and
wraps. Columns are separated by dim vertical rules (`┆` on Unicode terminals, `:` on ASCII ones), on the provider
list and on model lists; each rule replaces the one-column gap the cell already had,
so it costs no width and the header labels can never touch.

Key ids are drawn **in full**, bucket included (`personal.openrouter.free`): nothing is
omitted from the id and the title carries no "ids shown without ..." note. Selection and
filtering use the same full id.

Width: the key id column is sized to the **longest full key id** (30 in the 2026-09-30 snapshot:
`personal.experientiallabs.free` and `personal_maestro.deepseek.paid`, measured over ALL provider rows,
never the visible page) and is drawn **whole** whenever the terminal has the room: it takes its full
width BEFORE the optional `oldest probe` column and the optional `free` block, and before anything else optional. Only when even the mandatory
columns plus the full id do not fit is it elided, **with a visible marker** (an em dash in Unicode,
`~` in ASCII, never a plain hyphen), using the same distinctness-aware split as model ids (so
`openrouter-x-1` and `openrouter-x-2` stay different), never hard-cut. Measured on the real snapshot (57
providers, longest full id 30): every id is whole from a **94-column** terminal, `oldest probe` appears from
**107** columns, `free` from **117** (it needs `oldest probe` too, so a narrowing terminal loses `free` first, then
`oldest probe`), and at the 80-column floor the id gets 16 columns (56 of the 57 ids are elided there;
2 still at 93 columns, none from 94). A 45-character id would be whole from 109 columns, `oldest probe` from
122 and `free` from 132. The id column is capped at 64 so a hostile id cannot starve the other columns; spare width beyond the
full id, `oldest probe` and `free` is left empty at the right, never padded into a gap. The `models` cell is 7 wide (`N`
or `N/M` with M withheld; the worst real pair `469/100` fits, a wider one abbreviates and finally reads
`big/big`), so it never shifts a column.

**Rules that keep the numbers honest.**
- *No age cutoff, an outdated notice instead:* every reader (the counts, the verdicts, the
  `K ok` figures, the filters, the hide-gone toggle, the provider status and **the cells drawn on a
  model row**) uses a bench record whatever its age. Only a record with no timestamp, or one
  dated more than 5 minutes beyond the later of the picker's start time and the real clock
  (a hand edit, a clock that ran ahead), is refused. An old list is announced, never hidden:
  when **more than half** of the bench records are more than 7 days old (`BENCH_OUTDATED_DAYS`, the
  sweep's own default `--ttl`, a test keeps the two equal; `BENCH_OUTDATED_SHARE` = 0.5: exactly half does not
  trigger it) a yellow
  line is drawn right-aligned just above the footer, on the provider list and on model
  lists and flat scope: `Model Status might be outdated! Last time the list was fully updated
  was 2026-09-29, run node refresh/bench-cli.mjs --live to update your list fully`. The date is
  the OLDEST record's (every listed route was probed at least then: the last time the list was fully
  updated), UTC `YYYY-MM-DD`. The full sentence needs about 154 columns; on a
  narrower frame the words shorten from the front and the command stays whole (from 88 columns: `Status may be
  outdated (full update 2026-09-29): node refresh/bench-cli.mjs --live`, then `Outdated since
  2026-09-29: node refresh/bench-cli.mjs --live` (the last fits the 78-column floor)); old records are never hidden or dimmed: the notice and the `oldest probe` column are what show how old the data is. With no bench
  data at all there is no such line (the `benched - run bench-cli --live` stamp is the
  disclosure). The line costs one row on every list screen while it shows (`rowsAvail`, shared by
  the reducer and the renderer, so no frame exceeds the terminal height). The provider list uses
  the stamp and the per-provider age histograms baked into the snapshot (`benchOldestAt` and each row's
  `benchAgeHist`, schema 9; about 3.8 KB more on the real 57-provider file); once `bench.json` has been
  loaded (first model screen) its own oldest stamp and histograms replace them (an empty or missing file leaves
  the snapshot's). The sweep engine keeps its own
  7-day `--ttl` and retention window; none of that changed.
- *One dedupe rule, routes:* an `x` and an `x[1m]` are two selectable routes that share
  one probe record. Both count, everywhere (counts, verdicts, the model-level and
  provider-list figures, the ok-only list), so a count always equals the list it
  describes. (The provider list's `ok`..`err` columns can therefore add up to more than
  the number of distinct ids.)
- *Stamps are UTC* and say so: `benched 09-29 12:35Z`, `routable ...Z`, `discovered
  ...Z`. The provider list's `bench MM-DD` is a date only.
- *Cells never lie:* a count of 100,000 or more draws `big` (never a truncated number),
  and a duration over 9999 s draws `long`.
- *Snapshot builds:* `node menu/snapshot.mjs --build` prints one line saying what the
  provider columns were built from: `bench: N records as of <stamp>`, or `bench: no usable
  bench data, provider columns will be blank`. If `bench.json` is missing, corrupt or the
  wrong schema and the **previous** snapshot had counts, the build keeps the previous
  counts and their stamp and says `bench: no usable bench data; kept the previous counts
  as of <stamp>` instead of silently blanking them. Carried counts have no age limit (the
  outdated notice says when the list needs a sweep); only a missing or future stamp stops the carry.
- *Font fallback:* the column rule is `┆`, which some fonts (Consolas, for one) lack. Set
  `UW_PICKER_COLSEP=ascii` for `:` or `UW_PICKER_COLSEP=latin` for `¦` (U+00A6, in every
  font). Anything else, and any ASCII terminal, keeps the default.

The counts and verdicts are a snapshot of the last sweep, **baked into the
snapshot**, not read live: the provider list never opens `bench.json` at startup. After a sweep, refresh them by rebuilding
the snapshot, which also adds `bench MM-DD` (the sweep's date) to the header
where it fits:

```powershell
node menu/snapshot.mjs --build
```

A snapshot built before this change is schema 5 and is refused (the picker says
to rebuild); a rebuild with no `bench.json` shows blank cells.

### 6e. Route hints baked at snapshot build: blank `FREE?` badges and alias labels

Two hints are computed by `node menu/snapshot.mjs --build` from the bench data it already
loads (`menu/route-hints.mjs`; the same usability rule as everything else: a record of any age
counts, a future-dated one changes nothing). Both are **additive optional fields** on a model row
(an older snapshot simply has none and renders as before; the schema is 9: `alive` and `outModality` joined the file in 7, the three-state `status` in 8, `benchOldestAt` and the per-row `benchAgeHist` in 9).

- **A `FREE?` badge whose fresh probe says `pay` is blanked.** `FREE?` means "zero price, or a
  provider-published `:free` name"; a provider that answers "this request requires more
  credits" is not (possibly) free. The badge becomes blank (still inside the closed set
  `FREE` / `FREE?` / `PLAN` / `PAID` / blank) and the row gets `badgeNote: "probe: payment
  required"`. `FREE` (real zero price and a grant), `PLAN` and `PAID` are never touched.
  Example (the 2026-09-29 snapshot and bench file): 12 routes change (kilo 2, xkiro 4,
  commandcode 2, teamorouter 3, tokenrouter 1). Refreshed on every rebuild, so a provider
  that is funded later gets its `FREE?` back once the probe stops saying `pay`.
- **Dead aliases point at the working route.** A route whose own fresh status is `gone`, and
  whose sibling in the same provider is freshly `ok`, gets `aliasOf: "<sibling id>"`. Siblings
  are found by the bench study's rules (plans/bench-study, section 4b): an org prefix
  (`org/x` for `x`), the bare id, punctuation or case (`qwen3-5-27b` ~ `qwen3.5-27b`), or a
  stripped suffix (`:free`, `:thinking`, `@eu`, `@us`, `-free`, `-latest`, `:nitro`,
  `:floor`); a `:batch` id is a different route and never gets an alias, and `x` / `x[1m]`
  is one model, not an alias. On a model list the output cell of such a row reads
  `= <sibling> (works)` (dim), and the `id:` line reads `id: <id>  = <sibling>` when it fits.
  The pointer is baked, but it is honoured only while both records are still fresh **now**
  (a sibling that has since stopped answering shows nothing). It is a label: enter still
  selects the row you are on. Example (same data): 59 routes (alibaba 26, openai 22, google
  7, nousresearch 2, openrouter 1, cohere 1), exactly the study's count; the test replays
  the study's frozen table (`plans/bench-study/models.csv`) to keep that true.

## 7. Troubleshooting

- **Picker doesn't open on `ctrl+g`:** run `node menu/doctor.mjs`. If
  `editor-wiring` isn't GREEN, re-run `. menu/install.ps1`.
- **`keysync/run.mjs` throws "multi-key provider(s) with no deliberate
  choice":** run `node keysync/key.mjs prefer <provider> <id>` naming one of
  the ids the error lists.
- **A snapshot fails to load with a schema mismatch:** run
  `node menu/snapshot.mjs --build` — an old snapshot from before a schema
  bump is rejected on purpose rather than silently misread.
- **Statusline shows the wrong provider/model:** check `omcHud.elements.modelFormat`
  in `~/.claude/settings.json` — `"full"` shows the raw provider-qualified id;
  the default, `"versioned"`, truncates to the bare model family name.
- **Claude Code startup is very slow (~1-2 minutes):** run `node menu/doctor.mjs`;
  the `startup-discovery` row goes RED when
  `env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` is set in
  `~/.claude/settings.json`, AMBER when a large `~/.claude/cache/gateway-models.json`
  is left over. With the variable set, Claude Code fetches the full model list at
  every launch and processes the cache it writes; at UW's ~6,000 models that is
  ~100 s against ~10-16 s without it (measured 2026-09-09 and 2026-09-29).
  **It keeps coming back:** CCR's claude-code profile defaults that variable to
  `"1"` and rewrites it into `settings.json` on every profile apply, so a hand
  edit lasts only until the next apply. `keysync/run.mjs` now strips it after
  CCR's write and sets the cache aside, so `node keysync/run.mjs --target live
  --i-know` is also the repair. Anything that re-applies CCR's profile without
  going through keysync (the CCR web UI, a CCR restart) can put it back, and
  the doctor row is how you find out. Configuration cannot turn it off:
  Claude Code gates on raw truthiness, so `"0"` is still ON, and CCR drops empty
  values and re-defaults `"1"`. Also note that a terminal opened *from inside* a
  running Claude Code session inherits the variable from that session's
  environment and will regenerate the cache; open a fresh terminal to test.

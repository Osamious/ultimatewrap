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

### 5a. The fixed default model (the model every new session starts on)

The default is owner data in `~/.llmkeys/default-model.json` (`{"model": "...", "setAt": "..."}`),
not a constant and not something a keysync run decides. Resolves #74 (the issue is
closed by the owner after a verified live apply, not by this change).

```powershell
node keysync/key.mjs default-model show
node keysync/key.mjs default-model set "anthropic/claude-sonnet-5-5[1m]"   # --force (last) silences the advisory
node keysync/key.mjs default-model clear                                    # anchor behaviour returns
```

- **What it changes:** only the profile's `model` (`profile.model`,
  `profile.claudeCode.model`), and so the three env vars CCR derives from it
  (`ANTHROPIC_MODEL`, `CCR_CLAUDE_CODE_MODEL`, `CODEXL_CLAUDE_CODE_MODEL`). keysync
  re-asserts them after CCR's rewrite and again at its final verify. The four
  `ANTHROPIC_DEFAULT_*` tier mappings, `settings.model`, `effortLevel` and
  `modelSettings` are never touched.
- **`sonnetModel` stays `anthropic/claude-sonnet-5`:** `/model sonnet` and
  sonnet-alias subagents still resolve to sonnet-5, not 5.5. Subagents that
  inherit the main model get the default (5.5).
- **A `/model` pick lasts only for the running session.** `env.ANTHROPIC_MODEL`
  beats `settings.model` for new sessions (#74), so the next session starts on the
  default again.
- **`set` is shape-checked only** (no whitespace/control characters, `"`, `,` or
  backslash; must be `<provider>/<id>`), plus an advisory warning for an
  `anthropic/` id missing from `state/anthropic-ids-cache.json`. The row's existence
  is checked by `keysync/run.mjs` against the built picker, including in `--dry`.
- **It takes effect at the next live keysync run.** Until then any CCR re-apply
  (gateway start, saveApiKeys, profile launch) can revert the settings env to the
  previous anchor: set the file and apply in one sitting.
- **Relay down / row absent / corrupt file refuses a profile-writing run:** exit 1
  before any write, previous values kept, the message names the cause. Fix the id,
  bring the relay up, or `default-model clear`. `--no-profile` (gateway only, no
  profile, no settings.json) still works and only warns.
- **Which file a run reads:** a live run (`--target live`) ALWAYS reads
  `~/.llmkeys/default-model.json`. `UW_DEFAULT_MODEL_FILE` is IGNORED for a live run
  (a loud `UW_DEFAULT_MODEL_FILE is set and IGNORED for a live run` line is printed)
  unless `--default-model-file <path>` is passed. `--dry` and `--target isolated` honour
  the env var (tests, one-off dry runs). Every run prints `source: <path>`, or
  `default model: none (<path> absent; profile anchor decides)`.
- **Last-applied marker:** after a successful live profile-writing apply with a default,
  keysync writes `state/default-model.applied.json` (`{model, appliedAt}`, local,
  gitignored). If a later live profile-writing run (or `--dry`) finds the default file
  ABSENT while the marker exists, it refuses (exit 1, nothing written) instead of
  silently reverting new sessions to the anchor. Restore the file
  (`node keysync/key.mjs default-model set <id>`) or deliberately return to the anchor
  (`node keysync/key.mjs default-model clear`, which removes the file AND the marker).
  `--no-profile` is unaffected. A default file over 4 KB, or not a regular file, is a
  loud error; ids are also run through the repo id sanitiser (max 128 code points).
- **If a live apply fails after `saveConfig`:** CCR's config DB has ALREADY committed the
  new `profile.model` and Providers; only `settings.json` is restored. A later
  CCR-initiated apply (gateway start, saveApiKeys, profile launch) rewrites
  `settings.json` from the DB value. The failure output leads with this, the
  restore-point path and the restore command; re-running keysync once the cause is
  fixed re-commits and re-asserts the default.
- `set` on a non-`anthropic/` id warns that it is shape-checked only; keysync verifies
  it against the live picker rows at the next run and refuses a profile run if absent.
- With **no** default set, a live profile run prints a WARNING first if it is about
  to change a hand-set `env.ANTHROPIC_MODEL` to the profile anchor.

### 5b. The subagent model policy (which model your subagents run on)

A policy chooses the model each Claude Code subagent runs on, instead of the model it asked for.
It is owner data, written only by the CLI, and it starts in **shadow**: it logs what it would
do and changes nothing. `shadow` is the word on every screen; nothing is enforced until you
say so, and a wizard or a preset never enforces.

```powershell
node keysync/key.mjs subagent-policy status                 # the verdict first (off, saved, waiting, idle, shadow, enforcing, paused or degraded) and the one command that helps, then about four lines: the policy, the compiled copy, what the router last reported
node keysync/key.mjs subagent-policy preset                 # the five ready-made choices with live counts
node keysync/key.mjs subagent-policy preset free            # preview one (the equivalent flags and what it would do); nothing is saved
node keysync/key.mjs subagent-policy preset free --confirm yes --live yes
node keysync/key.mjs subagent-policy wizard --live yes      # three questions on a terminal, a preview, then a save in shadow mode (it needs --live yes like every command that saves)
node keysync/key.mjs subagent-policy last 20 --since 24h    # what the last subagents asked for, what ran, what the policy would use, in local time (--json yes for scripts)
node keysync/key.mjs subagent-policy explain groq/llama-3.3-70b --mode free --free-scope providers   # would this model be allowed? saves nothing
node keysync/key.mjs subagent-policy why EMPTY_SET          # what a warning means in plain words, and the command that fixes it
node keysync/key.mjs subagent-policy pause                  # subagents run exactly as they asked from the next request; your toggles are kept
node keysync/key.mjs subagent-policy resume --live yes      # continue (checked like set --enforce enforce)
node keysync/key.mjs subagent-policy undo --live yes        # back one step (refused while paused: resume first, or add --lift-pause yes)
node keysync/key.mjs subagent-policy help                   # the toggle map and every command
```

- **Running the examples in a fixture.** A test run names its own files instead of the real ones
  (`T=$(mktemp -d); F=$(node test/fixtures/subagent-flags.mjs --dir "$T")`), and the flags it needs
  depend on the command. `set`, `show`, `status`, `explain`, `rebuild`, `preset`, `wizard`, `resume`
  and `undo` take the full set `$F`. `last` takes only `--state-dir "$T/state"`; `report` takes
  `--state-dir "$T/state"` and optionally `--snapshot-file "$T/snapshot.json"` (the prices) and
  `--logs-file <a fixture request log>` (for `--outcomes yes`; a fixture run that names none reads none),
  and `selftest` takes no file flag at all (its approval file has one fixed place that no flag can
  move). `pause`, `rollback`
  and `clear` take only `--policy-file "$T/llmkeys/subagent-policy.json" --state-dir "$T/state"`.
  `why` and `help` take no file flag. `$F` given to `last`, `pause`, `rollback`, `clear` or `why` is
  refused as E_USAGE ("unknown or not applicable flag"), and a half set is refused as "incomplete
  test-flag set". A fixture run never needs `--live yes`; a run on the real files always does.
- **What `status` prints.** Not one line: the verdict and its next command first, then the policy,
  the compiled copy (age, eligible models of the snapshot routes, how many are not tool-tested) and
  what the router last reported (when, how many subagent requests of how many), plus one plain line
  for each router warning. States: `OFF` (no policy saved), `SAVED-NOT-COMPILED`, `WAITING` (saved and
  compiled; the router has not reported this exact copy yet and uses it from its next request: run
  `status` again after you use Claude Code), `NOT-WIRED` (no router has ever reported and the compiled
  copy is older than about ten minutes, or a router that ran for a long time still reports an older
  copy), `IDLE` (the router reported this exact copy earlier and has been silent for over a day: it
  reports only while Claude Code runs, so nothing is wrong unless you used Claude Code since),
  `SHADOW`, `ENFORCING`, `PAUSED` and `DEGRADED(CODE)`. A saved policy file that cannot be read is
  `DEGRADED(E_OWNER_CORRUPT)` with exit 4 and the command that clears it. After a `set` the first line
  is `SAVED:` (the same state `status` calls `WAITING`).
- **The free presets.** `preset free` (and answer 3 of the wizard) is the NARROW set: only models
  tagged free (the count is printed in the preview: `N models tagged free; M models on free-labelled
  providers`). `preset free-wide` is the wide set: every working model on a provider you labelled
  free, which is a much larger set and can include models that have a price. Every free preview shows
  both counts from the live funnel.

- **The three toggles.** Toggle 1 *source* (`--source same-provider|all-providers`: only main's
  own provider, or any provider). Toggle 2 *mode* (`--mode dynamic|inherit|free`: any model,
  main's own model, or free models only; with `free`, `--free-scope models|providers|providers+deposit`
  says which models count as free). Toggle 3 *context* (`--ctx any|128k|200k|256k|512k|1m|prefer-256k|prefer-512k|prefer-1m`: `any`
  excludes nothing; `128k` to `1m` are hard floors that leave out every model with less known
  context, unknown included; the `prefer-` values put models at or above that context first and
  leave out nothing; the context the asked model has never raises the floor above the one you chose;
  `set --dry yes`, `show`, `preset` and the wizard print how many rows pass each floor, each over
  its own denominator, so you can pick one knowingly). A model whose context is unknown can pass
  the 128k stand-in floor on the context of a same-name sibling (shown `c?`, never used for a higher
  floor); safety, guard, embed, rerank, OCR, LoRA, moderation and under-4B models are never
  candidates. A model that failed once in a tool test ranks below a clean one of its class. Inside
  a rank band models are then ordered by the tool sweep's own blocked states (see below: they rank a model below clean ones, never out), the tool-test steps (big request, then L4), the tool-test markers (each clean above flagged, strongest flag first: forced-choice only, argument fidelity failed, tool_result use failed), speed
  quartile (of the rows in your set), context class (1M, 512k, 256k, 200k, 128k), price, and only
  then by how recently the model was probed (live within 7 days, probe within 14 days, older: this
  depends on the calendar, so it only breaks ties and never outranks speed or context); a hash of
  a failed spawn call (it matters only for a model acting as a main agent) breaks ties just before that, and the hash of
  the model id breaks the last ties, so no provider is favoured by its name. Models with a known tool failure (a filed issue) stay
  out until a real tool test says otherwise; free models dropped on a rate-limit, timeout, empty or
  network status of an old test are listed as waiting for a re-probe, not treated as dead
  (`show --detail yes` names them). The tool sweep's result is the model's LATEST state, whatever the age of its speed test. A hard answer (gone, pay or auth, which the sweep never asks again, so a count of attempts means nothing for it) acts at once: gone leaves a model out as `unreachable` unless it has an earlier confirmed pass (then it only ranks lower), pay and auth rank a model lower. A soft answer (rate limit, quota, upstream unavailable, slow, timeout or error) ranks a model lower after 3 runs in a row with the same reason, and `error` never leaves a model out; the scheduling and budget states (cap, spend, not-run, empty and the like) are not used at all. A confirmed pass NEWER than the sweep's answer wins; an unreadable date makes the answer unusable (nothing happens). A held provider counts the same way, except that a held gone or pay is ignored for a provider that has any confirmed result (the sweep's own rule: it answered, so it was never gone or out of credit as a whole); a held auth always applies. When most of one provider's models carry the same soft or hard sweep state the report prints ONE line for the provider (for example "cleanapis: 32 of 32 bench-ok rows pending error") because the provider, not the models, is probably the cause. Every count says what it is of ("1 of 5 bench-ok model left out"). Your `--allow` pin does NOT override `unreachable` or `gateway-compat` (the model cannot be reached, or fails through the gateway); it still overrides a tool-tier verdict. A free model dropped on an old transient bench status that the sweep found gone is named in a list (re-probe skipped), never silently dropped. A model whose tool test failed in the gateway's own request translation (tagged `xw: gateway`) is left out as `gateway-compat` and is tested again only when CCR changes (a new CCR build re-queues it). Image-generation, translation and search models (`image`, `imagen`, `translate`, `search`, `deepsearch` as a word of the id) are never candidates. Rows whose 128k rests on a sibling's context are counted as `ctx unproven` in every preview (a context fact, on its own line, not a sweep fact): the only measured proof is the 400 KB big step (about 100k tokens), so the router's per-request fit check decides. Also
  `--banded yes|no`, `--handoff-notice yes|no`, `--enforce shadow|enforce`, `--inject off|on`
  and `--allow provider/model`. The presets: `follow-main` (mode inherit), `any` (dynamic, all
  providers), `free` (free, all providers, free scope models: only models tagged free), `free-wide`
  (the same with free scope providers: every model on a free-labelled provider), `free-1m` (free
  scope providers with ctx 1m).
  `set`, `show` and `preset` print the verdict first, then the change against the previous policy
  (`mode dynamic -> free; eligible 14 -> 7 models, 5 -> 2 providers`); `--detail yes` adds the whole
  funnel and every raw warning.
- **Files.** Your choices: `~/.llmkeys/subagent-policy.json` (and `.prev`, the one generation `undo`
  restores: written before every `set` or `clear` that changes something). The compiled copy the
  router reads: `state/subagent/policy.json` (a saved choice is not live until it is compiled; `set`
  does it, `rebuild --live yes` redoes it after a bench sweep or a key change). The router writes
  `state/subagent/status-<worker>.json`, `agents.jsonl` (one line per new subagent, plus three
  rotated files of 1 MiB) and `cooling.json`; `shadow.flag` is the pause (the router stats it on
  every request) and `paused-from.json` remembers what `resume` should restore.
- **Pause, resume, undo.** `pause` (and its older name `rollback`) is compile-free and needs no
  `--live yes`: one word must work in an emergency. A pause that the router set by itself (a safety
  check tripped, shown as `DEGRADED(AUTO_ROLLBACK)`) is cleared by `resume` or by a `set`. `resume`
  puts enforcement back to what it was when you paused, through the SAME checks as
  `set --enforce enforce`, so it refuses (and the pause stays) while a precondition is unmet. `undo`
  restores the previous generation and recompiles it; while the policy is paused it is REFUSED
  (E_PRECONDITION, naming `resume`) because it would lift the pause as a side effect: add
  `--lift-pause yes` to go back one step and lift the pause in one command, and it says so. If the
  earlier policy cannot be compiled, `undo` prints the whole refusal and leaves you paused with the
  earlier toggles saved. A real `set` during a pause lifts it and says so (including that enforcement
  stays shadow when it was enforce before the pause). Every writing command on the REAL files (`set`
  without `--dry yes`, `rebuild`, `clear`, `resume`, `undo`, `wizard`, a confirmed `preset`) needs
  `--live yes`: a real save never happens without it on the command line (the wizard is refused before
  its first question without it). A test run names its own files with the test flags instead and
  never needs it.
- **Restore command.** The router file is replaced and restored only through
  `node harness/deploy-router.mjs --deploy yes --candidate <file>` and
  `node harness/deploy-router.mjs --restore yes [--from <backup>]` (a backup is made first); the
  CLI never touches it. `clear` removes the policy files and the router goes back to its exact
  legacy behaviour on its next request.
- **Tag-stripper note.** With `--inject on` main is asked to start a subagent prompt with
  `<CCR-SUBAGENT-MODEL>Provider/model</CCR-SUBAGENT-MODEL>`; CCR removes that tag before the agent
  runs. The router never relies on the tag being obeyed: an id outside the allowed list is replaced
  by the policy and the replacement is logged.
- **Native `/model` is not covered.** The policy chooses the model of SUBAGENTS only. What you pick
  with Claude Code's own `/model` (main) is yours, and CCR's own model list (a provider with model
  descriptions) is a second list the policy does not edit. Helper calls (titles, summaries,
  compaction) are never rewritten in any mode.
- **Reading `last`.** Claude Code's transcript shows the model that was REQUESTED, not the one that
  served the request: the served model is in `last`, in the doctor and in CCR's `request_logs`.
  A free subagent that runs out of limits is handed to the next free model on its next request; for a
  daily cap the honest bound is ONE failure, then avoidance: Claude Code fails the subagent at once
  when the retry delay is over a minute, so no retry reaches the router, and the router marks the
  model as resting so the next subagent starts elsewhere.
- **The 6 h rest.** A model that fails rests 2 min, then 10 min, then 60 min, then 6 h. The router has
  no memory of a failure that happened "consecutively" in the strict sense: it approximates it with
  the rest period plus one quiet hour, so a model that fails every 30 to 60 minutes reaches the 6 h
  rung in about 3 hours.
- **The report and the self-test.** Examples (a test runs each one in a fixture with the flags its
  command takes):

      node keysync/key.mjs subagent-policy report --since 24h     # asked -> ran per agent, the policy's choice, an input-token cost estimate against main's model
      node keysync/key.mjs subagent-policy report --outcomes yes  # adds the gateway request log, read only (--json yes for scripts)
      node keysync/key.mjs subagent-policy selftest --plan yes    # what a sandbox self-test would do, and its plan hash; it starts nothing

  `report` answers "what did my subagents run on, and what would
  that have cost on main's own model?" without the policy being enforced. It lists the newest 20
  agents (asked -> ran, what the policy would use or chose, why), then totals, each over the
  population it was counted on ("6 of 8 agent decisions would move to another model"), the router's
  own counters (these are for the router's whole lifetime, not for `--since`), and one savings
  line. The savings line is always labelled "estimate, input tokens only, snapshot prices": it
  multiplies the token count of the FIRST request of each agent (the log holds one line per new
  agent, so later requests are not in it, and real totals are higher) by the input price the model
  snapshot lists, for main's own model, for what ran and for what the policy chose. An agent with no
  token count, with no known main, or on a model whose price the snapshot does not list is left
  out and counted ("2 without a token count ... 2 with an unlisted price"). `--session` takes the
  logged session id (the log keeps the first 8 characters of a session id) or a longer id that starts
  with exactly those 8; a shorter fragment matches nothing. The log file holds only new-agent lines and
  hand-over lines; sampled repeat requests are in the other log and are not reported. `--outcomes yes` adds ground truth:
  it reads the gateway's request log READ ONLY (never written, never by the router, never on a
  timer), pairs each agent with the request of the same session and agent within 2 seconds, and says
  how many of the matched requests the gateway served on the logged model, on another model, or
  answered with an error status; the gateway keeps only recent request rows (how long is not
  specified here; the observer notes in section 6 report roughly 1.5 hours on one machine, issue
  #134, not a guarantee), so older agents show as "no matching request". An unreadable log or snapshot is said in the report, never left out.
  The report also prints "context growth", an estimate from the router's classifier log: for each
  subagent, its largest later request divided by its first request, as a median, 90th percentile and
  maximum over the n subagents with two or more counted requests; it measures the headroom a model
  needs and changes nothing. `report` and `status` also say how many eligible models have no known
  request-size limit, so the size check does nothing for them until a tool test records one.
  Traffic shares come from the same classifier log and count CLIENT requests only: the requests that
  carry no session id (logged as `nosessio`) are the UW tooling's own probe traffic (the keysync and
  refresh probe profiles, machine-paced), not a client session and not a subagent bypass, so `report`,
  `status` and `show` print them as their own line ("non-client probe traffic (N of M classified
  requests), excluded: they carry no session id") and leave them out of every main, sub and aux
  share; each share names its denominator (client requests with a session id). A second line splits
  the agent-shaped client requests into teammates (an agent id without the billing flag) and
  built-in subagents (the billing flag), and says how often the two detectors disagree: that
  disagreement is made of teammates. The router's own lifetime counters (`req`, `main`, `sub`) are
  per router, not per session, so they still include the probe traffic; the lines above are the
  client view. Any classifier-accuracy matrix must use these client-only denominators.
  `--json yes` prints one JSON object whose shape is frozen (`schema` 3, a fixed key order with
  `traffic` last, pinned by a test); `last --json yes` keeps its own shape.
  `selftest` is the one-run check that the policy really changes a subagent's model and leaves
  helper calls alone, on a real headless Claude Code inside the isolated sandbox. `selftest --plan
  yes` prints what a run would do and its plan hash; it reads no data file and starts no process.
  `selftest --approve-plan yes --live yes` is yours to run in a terminal: the command refuses without
  one and needs the first 12 hex characters of that hash typed. That blocks a pipe and an accidental
  run and pins the plan and the files; it does not prove a person typed it (a program that opens a
  pseudo-terminal passes the terminal check, the same documented limit as the sandbox approval).
  The sandbox runner is `harness/subagent-scenarios.mjs` (built, never yet run; an approval is
  refused if it is missing). `selftest --run
  yes --live yes` needs that approval (one use, valid 24 hours, void if the plan or any file the run
  executes changed), uses it up, and prints PASS or FAIL for the two checks (a subagent request
  reached the stub on the policy's model and the sandbox router's own log shows it chose it; a helper
  call stayed on the model it asked for). A check
  that sees no matching request fails. A run is refused, with the approval left unused, if the
  sandbox runner `harness/subagent-scenarios.mjs` is missing. The same file is the END-TO-END
  SCENARIO SUITE: `node harness/subagent-scenarios.mjs --plan` prints eleven scenarios (spawn and
  serve, a 429 handoff, all models limited, team agents, a `/model` switch, a corrupt, missing or
  newer policy, a worker restart, helper calls, rollback, a 20-agent fan-out, a daily-cap 429) and
  four chaos checks, what each must prove, and a plan hash, without reading or starting anything.
  A run (`--approve-plan` in a terminal, then `--run`, optionally `--only 2,3` and `--runs N`)
  uses the same sandbox and the same one-use typed approval as the other sandbox runs, replays the
  request shapes a real client sends (no client is started), pins the installed CCR in the approval,
  and prints PASS, FAIL, FINDING or DEGRADED per scenario with its run count and the client used; a
  line that is not a PASS says it is not G3 evidence, and the exit code is non-zero for a FAIL or
  for a FINDING outside scenarios 2, 7 and C4. `--real yes` (also on `selftest`) is a SEPARATE,
  riskier mode with its own consent: it starts a real headless Claude Code for scenarios 1, 2, 3
  and 11 only, pins the launcher's path, hash and version in the approval, and checks afterwards
  that the real `~/.claude.json` and `~/.claude/projects` were not touched and no request of the
  client reached the live gateway. A FINDING names
  something the sandbox could not show (for example that no retry signal reached the router); a
  DEGRADED line is the daily-cap case: one failure and then avoidance, never a seamless handoff.
  How the suite reads the router: every counter and the cooling list come from a fresh status (the
  router flushes `status.json` at most every 5 s, so the suite waits 5.1 s, sends one helper-shaped
  request and reads), a worker that served earlier scenarios is replaced when it holds their state
  (core pid must change; `cooling.json` is deleted again after the swap), and a scenario that needs a
  clean cooling list checks it first. Main's own model comes first when it is a row of the policy (plan
  6.2): scenarios 3 and 10 keep main outside the set, scenarios 2 and 7 keep it in on purpose; whether
  that shortcut is wanted is an open owner decision, the suite documents it and does not judge it.
- **Counts carry their denominator.** Every figure printed says what it is a count of ("7 of 7
  eligible models are not tool-tested"). "Eligible" means allowed by the toggles; "usable" means it
  can stand in for a subagent (a known context of at least 128,000) and fits the request.

## 6. Phase B — catalogue refresh and health

Refresh actions 6a to 6d are deliberate, manually-invoked commands by design; none
runs on a schedule (a scheduler that supplies its own "yes, do this" on every
tick turns a safety gate into a constant "yes"). 6e describes what the snapshot
build derives from the bench data. 6f is the one exception to "manual": the picker
starts a short, read-only catch-up of live model status each time it opens (no timer,
no daemon, never a request to a provider), and it has a kill switch.

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

**Live observations never change `bench.json`.** Since the live feed (6f) the picker can draw a status from your real
requests, in UPPERCASE, but that comes from a separate file (`state/observed.json`) merged over `bench.json` when a list is drawn.
A sweep, `--compact` and `--reclassify-notices` work on `bench.json` exactly as before (`--redact` also redacts the overlay, see 6f), and a probe newer than a live record
wins. Live results never refresh `oldest probe`, its age histograms or the outdated notice; only a sweep does. (The model list's
own `probed` cell is the exception in display only: a live row shows the age of its live observation.)

**"Fresh" in this section means usable, not recent.** The picker has no age limit: a bench record is used whatever its age,
unless it has no timestamp or is dated more than 5 minutes ahead of the clock (`isUsable` in `menu/bench-data.mjs`). Where the text
below says a "fresh" record, that is what it means; how old a record is shows in `oldest probe`, `probed` and the outdated notice.
The sweep's own `--ttl` (7 days) and the 14-day protection of real records (below) are a separate, sweep-only matter.

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

# Keep more (or fewer) dated copies of bench.json in state/bench-history (default 30, at least 1; there is no way to turn it off).
node refresh/bench-cli.mjs --live --keep-history 60

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
  worst case at the stream-cut allowance: 384 tokens by default, or `--max-tokens` when `--stream-cut 0`
  turns the cut off). Explicit flags always win over either mode's default. Rows over the ceiling are recorded `skip` (`row-cost`), and paid rows
  past the cap `skip` (`spend-cap`). A row being retried faces the cap again (a cap
  leak: retries used to bypass it, and a $2.00 cap reached an estimated $2.12; a retry
  that no longer fits is recorded `skip:spend-cap`). **The cap is an estimate, not a
  hard bound on the invoice**: each probe is charged from the output tokens the
  provider reported (a timeout at its worst case), and each probe in flight holds its
  worst case (the cut allowance, 384 tokens by default) until it finishes, so concurrency cannot push the
  estimate past the cap. A row that fits only until those holds are released waits
  instead of being skipped. Refused or errored requests (401/402/404/5xx) are normally
  not billed; a stream that fails after tokens flowed can be, and is charged when
  reported. The dry run says which mode it is (`probe-all (default)` or `economy`),
  prints both the typical-answer estimate and the worst case (every paid row at the full
  cut allowance), and when the cap can bind says it cuts the late, expensive rows (paid
  rows are queued cheapest-first within each provider). It lists the costliest rows
  over the ceiling, and a finished run prints how many rows remain unprobed and why,
  by count (`row-cost`, `spend-cap`). Re-run to resume; skips are always re-probed.
- **One sweep at a time.** A live run holds an exclusive lock file
  (`~/.uw/state/bench.lock`: pid, start time, mode). A second `--live`, or a
  `--compact` while a sweep runs, is refused (`another sweep is running (pid N since
  HH:MM); nothing was sent`, exit code 5) before anything is sent or written, and the
  dry plan says so too. A lock whose process is gone, or that outlived its
  `--max-minutes` plus 10 min (24 h plus 10 min for a run with no limit), is taken over with a printed notice; it is released on a
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
- **Exit code:** 0 for a normal outcome or a Ctrl-C (also the dry plan, `--compact`,
  `--redact` and `--reclassify-notices` when they succeed); 1 for a failure before or outside the
  sweep (no usable snapshot, no gateway settings or the gateway not answering at start-up, a
  `--only` / `--only-file` that matches nothing, an unreadable list, a failed `--redact` or
  `--reclassify-notices`); 2 for a bad argument; 3 when probes were sent and not one model
  answered `ok` (check the gateway and the keys); 4 when the gateway never came back; 5 when
  another sweep is running. The closing snapshot rebuild never changes the code.
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
  `~/.uw/state/bench-history/bench-<UTC yyyymmddThhmmssZ>.json` (a second copy in the same
  second gets a `_NN` suffix) and prints
  `bench: history saved -> bench-history/bench-<stamp>.json (kept N of M)` (M copies existed once the
  new one was written, N remain after pruning, `; pruned K` when older ones were removed; `kept 1 of 1`
  when it is the only one). **The copy is always redacted** (every record goes
  through the same provider-text redaction as compaction, so a `bench.json` written
  before redaction existed cannot leak a key fragment into history; measurements and
  statuses are untouched; the copy is content-identical, re-serialised as compact JSON,
  so identical for files the tool wrote). It
  saves `bench.json` only, not an unfolded `bench.jsonl` log: the sweep's end-of-run
  compaction folds the log into `bench.json` later, and the next run's copy has it. A
  copy identical to the newest one is not repeated (`bench: history unchanged (identical to <name>)`). At most 30
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
  limit) and prints one line, `bench: snapshot rebuilt (<summary>)`, where the summary is the
  build's own `N providers, M models, catalogue <date>` line and its `routability: ...` line joined
  with `; `, **clipped to 120 characters** (so a long routability timestamp can be cut off; the real
  routability stamp is in the snapshot). Example from a one-row run on 2026-09-30:
  `bench: snapshot rebuilt (57 providers, 6032 models, ...; routability: ...)`.
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
status), `probed`, `ttft`, `total`, `tok/s`, `ctx`, `$in`, `$out`, `badge`, `modality`, `TVR`,
`output`. The `limit` column is gone (it only ever showed `?`). The id column is only as wide as the provider's longest id (capped at 40;
longer ids are elided in the middle), so the other columns sit beside it, and what is
left over is empty space at the right. The id keeps at least 22 columns before any
optional column is dropped. Narrow terminals drop columns in a fixed order: `output`
first, then `probed`, then `tok/s`, then `total`; `modality` is always drawn, so it outlasts all three; the id
grows toward its full width only once every column that fits is showing. At 80 columns you
get id (22, its floor), `stat`, `ttft`, `ctx`, `$in`, `$out`, `badge`, `modality`, `TVR`; `total`,
`tok/s` and `output` do not fit (a short id, about 10 characters, still leaves room for
`total` and `tok/s`). **Every column shows from a 103-column terminal** (101 when the
longest id is 20 characters or fewer), with the id at 22 columns; a wider terminal
first lets the id grow to its content, then widens the preview.

`probed` (6 wide, right after `stat`) is the age of THAT model's own probe record: `<1m`, `45m`, `5h`, `3d`,
`40d`, right-aligned, from the record's own timestamp (`recordAge` in `menu/bench-data.mjs`, the one place a
record's age is decided) in exact seconds against the picker's frozen clock: no hour bucketing, since the model
list reads `bench.json`. Same text rules and colour bands as the provider list's `oldest probe` (green under 2d,
yellow under 4d, orange under 7d, red from 7d, from the same constants; orange is 256-colour 208, bright red 91 on
16 colours; colour off shows the text). Blank means the model has no usable record. **It was added without moving
any older column:** `total`, `tok/s` and `output` appear at exactly the widths they did (total from 86 columns,
tok/s from 92, output from 103 for an id of 22 or more; 84 / 90 / 101 for 20), and the id column is unchanged
from 103 columns up. `probed` itself first appears at 99 columns (97 for an id of 20, 98 for 21), after `total`
and `tok/s`. `output` pays for it: its minimum shrank from 10 to 3 characters and it is drawn only together with
`probed`, so between 103 and about 120 columns (while the id is still growing to its content) `output` is a
narrow 3-character sliver, 16 at 134 columns, 122 at 240 (for an id of 40); its header is clipped to the width
(`out` at 3); while it is narrower than 8 columns the `= <alias> (works)` hint and the `skipped: why` text draw blank rather than a fragment (the `id:` and `reply:` lines carry them whole). A `skip` record has no `probed` age (it is not a probe result; `recordAge` is null for it, for a non-positive stamp, for one dated in the future and for an age of 100,000 days or more). Between 99 and 102 columns `probed` shows without `output`, and the id gives up the few columns of
growth beyond its 22-column floor that it would have had (it never goes below the floor). Prices are at most
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
is still the listing's raw capability token. On the 2026-09-30 snapshot (6,032 routes) this
gives: `chat` 3,657, `chat?` 590 (`bench-ok`, so it moves with every sweep), `image` 106, `embed` 87,
`video` 44, `audio` 33, `stt` 31, `live` 20, `rank` 11, `ocr` 9, `mod` 6, `other` 5, and `?` 1,433
(23.8%: routes with no positive evidence). The per-source split of `chat` was measured on
2026-09-29 only (3,672 `chat`: `mode` 2,097, `output` 1,346, `listing` 229) and was not re-measured.

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
- `ctrl+x` **no gone**: on model lists and in flat scope it hides every model whose latest usable
  bench record is `gone` (the route is not found upstream), whatever its age; a route with no
  record is shown. **On either level it also changes the percent figures**:
  the provider list's `ok` `%` and both headers' `K ok (P%)` are ok / models while the toggle is
  off, and ok / (models minus gone) while it is on (a zero denominator reads `-` in the provider
  list's `%` cell, and the header then shows the `K ok` count without a `(P%)`). At the provider
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
  two steps (packed, then `[1M]` and `[-gone]`) so the counts on the right are never clipped
  (`menu/style.mjs`). The provider list draws only `[no gone]`. Real-console delivery of `ctrl+x` and
  `ctrl+e` was confirmed by the owner on 2026-09-30.

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
--build` (the `bench MM-DD` stamp at the right end of the `id:` line is that date). Model lists (level 1 and flat scope)
are LIVE: their rows, `benched` stamp, `K ok` and the ok-only filter all read
`bench.json` on first draw. After a new sweep the two can therefore disagree (for
example `1396 ok` on the provider list and `1404 ok` in flat scope) until the snapshot
is rebuilt.

**The provider list's sweep columns.** Level 0 is, left to right: `key id`, `status`,
`oldest probe` (only when the terminal has room after the full key id), `models`, `ok` and its `%`,
`free` and its `%` (only when it has room after `oldest probe`), then seven raw
counts in this order: `empt`, `auth`, `pay`, `rate`, `gone`, `t/o`, `err` (the `ok` count is
the `ok` sub-column; `skip` is not a column). There is no health column and no `probed` column at
this level: `probed` exists only on model lists, and the provider's age is `oldest probe`.

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
  - **blank**: no probe record (a provider nobody benched has no verdict).
  It is a label only: routing never prunes a provider for reading `down` or `dead`. It is
  baked as `benchFlags.status` at snapshot build (schema 8); the older two-state
  `benchFlags.alive` (answered in any shape) stays in the file for other readers. On the
  2026-09-30 snapshot (57 providers): 42 alive, 15 down, 0 dead. The 15 down are the providers
  with no `ok` model at all (`pollinations`, `maestro`-`deepseek`, `gmicloudai`, `chutes`, `routllm`,
  `seekai`, `cerebras`, `sambanova`, `xai`, `tabiai`, `gorouter`, `indeedwebid`, `kiosapi`,
  `kktoken`, `justdowork`). The two-state version read all 57 as alive.
- `oldest probe` is the age of the provider's OLDEST probe record (the worst case, not the latest one: one
  stale model makes the provider read old), right-aligned in 12 under its lowercase header: `45m`, `5h`, `3d`,
  `12d`, `40d`. Whole minutes under an hour (`<1m` under a minute), whole hours under a day, whole days from a
  day; every unit rounds down (`59m`, then `1h`; `23h`, then `1d`; `47h` reads `1d`; at the provider level ages come from hour-filed records, see below). `-`
  means the provider has no probe record, blank means there is no bench data. It is coloured as a hint by how
  close the age is to the outdated threshold T = `BENCH_OUTDATED_DAYS` (7 days): **green** under 2/7 T (2d),
  **yellow** under 4/7 T (4d), **orange** under T (7d), **red** from T (7d) on; the bands are computed from the
  constant, never repeated. Orange is 256-colour 208, and bright red (91) on a 16-colour terminal (beside yellow 33
  and red 31); with colour off only the age text shows, which carries the whole meaning. The age is computed
  against the picker's own clock (fixed when it opens, so it does not tick while open) from an **age histogram**
  baked on each snapshot row (`benchAgeHist`, schema 9: `[[epochHour, count], ...]`, every probe status (a `skip` is not a probe result and a record with an unknown status is invalid: both are left out), the record's
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
  `benchAgeHist`, schema 9; about 3.9 KB more on the real 57-provider file); once `bench.json` has been
  loaded (first model screen) its own oldest stamp and histograms replace them (an empty or missing file leaves
  the snapshot's). The sweep engine keeps its own
  7-day `--ttl` and retention window; none of that changed.
- *One dedupe rule, routes:* an `x` and an `x[1m]` are two selectable routes that share
  one probe record. Both count, everywhere (counts, verdicts, the model-level and
  provider-list figures, the ok-only list), so a count always equals the list it
  describes. (The provider list's `ok`..`err` columns can therefore add up to more than
  the number of distinct ids.)
- *Stamps are UTC* and say so: `benched 09-29 12:35Z`, `routable ...Z`, `discovered
  ...Z`, `live HH:MMZ`. They sit at the right end of the `id:` line. On the provider list that
  line carries `routable`, `bench MM-DD` (a date only) and `live`; on model lists it carries
  `benched`, `discovered` and `live`.
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
snapshot**, not read live: the provider list never opens `bench.json` at startup. A `--live` sweep rebuilds
the snapshot itself when it ends (see the sweep notes above); after any other bench writer, refresh them by
rebuilding it by hand, which also updates the `bench MM-DD` stamp (the sweep's date) on the `id:` line
where it fits:

```powershell
node menu/snapshot.mjs --build
```

A snapshot of any other schema than the current one (9) is refused (the picker says
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
  Example (the 2026-09-30 snapshot): 12 routes change (kilo 2, xkiro 4,
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
  selects the row you are on. Example (the 2026-09-30 snapshot): 76 routes (alibaba 30, openai 27, google
  15, nousresearch 2, openrouter 1, cohere 1). The study's count on the 2026-09-29 data was 59 (alibaba 26, openai 22,
  google 7, nousresearch 2, openrouter 1, cohere 1); the test replays the study's frozen table
  (`plans/bench-study/models.csv`) to keep that true; the live count moves with each sweep.

### 6f. Live model status (the live feed)

The bench sweep (6d) measures a model only when you run it. The live feed adds a second, cheaper source: what
the router already recorded about your real requests. A model that answered `429` in your last session shows
`RATE` in the picker without a sweep, and a model that was failing and then answered again shows `OK`.

**What it does.** On every picker open, right after the first frame, the picker starts one detached,
short-lived Node process (`node --no-warnings refresh/observe-cli.mjs --catchup`). That process opens the router's own usage
database read-only, reads the rows added since the last run (a stored row id, the "watermark"), classifies each
one with the same classifier the sweep uses, and writes the result to `state/observed.json`. The picker merges
that file over `state/bench.json`, model by model. The child exits by itself in tens of milliseconds (two dry
runs on 2026-09-30 examined 282 new usage rows in 40 and 54 ms; a real detached catch-up started by the picker
launcher on 2026-09-30 took about 13 ms to spawn, updated `state/observed.run` within about a second, examined 9 usage
rows and exited cleanly).

**What it does not do.**

- It is not a daemon and has no timer. Nothing runs between picker opens. The gateway is never restarted.
- It never writes to the router's database, and it never touches `state/bench.json`, its log, its lock or
  `bench-history/`. A sweep and the live feed do not share a file.
- The catch-up never contacts the gateway. The only request it can cause is the one confirmation probe (below).
- It does not replace a sweep. A live record says "this model answered or failed for a real request at this
  time". It does not refresh `oldest probe`, the `probed` ages of probe records, the age histograms or the
  outdated notice (see "What the picker shows").
- Nothing from your prompts or the model's replies is stored. Only a status, a time, the router's request id and,
  for six failure statuses, the provider's own redacted error sentence (see "Privacy").

**Timing.** The first frame is drawn from what the previous run found. This open's result appears on the next
keystroke, a moment later (Node's start-up plus the tens of milliseconds of reading; the design measured a spawn at 11 ms on the picker's side, and a real launch measured about 13 ms). A new child starts at most once every 30 seconds.

#### Commands

```powershell
# What is it doing? Read-only: two small files, no database.
node refresh/observe-cli.mjs --status

# Switch it off, and back on. No source edit; see "The kill switch".
node refresh/observe-cli.mjs --off
node refresh/observe-cli.mjs --on

# Delete every live record, the feed's position (watermark) AND the confirmation spend caps (deletes observed.json and observed.run).
# The next run starts at the first UW-probe row in the last 3 days, else at the router's current last row.
node refresh/observe-cli.mjs --reset

# Dry run: read new usage rows, print what WOULD be recorded, write nothing (no overlay, run file or lock).
# It does read the router's database, read-only. Prints counts only, never message text.
node --no-warnings refresh/observe-cli.mjs --catchup --dry

# Run a catch-up by hand (the same thing the picker starts on open).
node --no-warnings refresh/observe-cli.mjs --catchup

# Dry run as if the first run had started 3 days back (1 to 30). Honoured only when there is no watermark yet
# (a fresh install, after --reset, or after the router's table was reset); otherwise ignored.
node --no-warnings refresh/observe-cli.mjs --catchup --dry --backfill-days 3
```

Exactly one mode flag per run (`--catchup` is the default). Two are refused with exit code 2, as are `--dry` or
`--backfill-days` without `--catchup`. Exit codes: 0 done or skipped, 1 a failed run (`observe: failed: <why>`), 2 bad
arguments, 3 the watchdog (a child that runs longer than 10 seconds is ended; 90 seconds for a confirmation).
`--confirm <provider/id>` also exists but is started only by the catch-up; run by hand it does nothing unless the
overlay holds a fresh reservation for that key.

Example `--status` output (the state after the real catch-up on 2026-09-30):

```text
observe: enabled
observe: last run: 2026-09-30T06:33:49.944Z; no error
observe: feed: ok
observe: watermark: id 71258 (row time 2026-09-30T06:33:49.051Z)
observe: overlay: 0 model record(s), 0 pending, written 2026-09-30T06:33:49.944Z
observe: last run examined 9; skipped {"unknownKey":1,"probe":1,"ignored400":1,"okSeen":6}
```

After a router schema change the same command adds one line right after `feed:` (only while the feed is `unavailable:schema`):

```text
observe: feed: unavailable:schema
observe: usage_events columns missing: status_code, duration_ms
```

`0 model record(s)` with `okSeen` is normal and healthy: a real 200 for a model that is already `ok` changes
nothing (it would only replace a reply preview with an empty one), so a quiet feed means everything you used
worked. `skipped` names the reasons rows were passed over (below).

#### The kill switch

`state/observe.off` is the persistent switch. `--off` creates it, `--on` removes it (creating or deleting the empty
file by hand is the same). While it exists:

- the picker starts no child;
- every reader ignores `observed.json`, so the picker draws exactly what `bench.json` says, with no `live` stamp and no
  uppercase marker;
- `--catchup` and `--confirm` exit at once, silently (`--status`, `--reset`, `--on`, `--off` always work).

`observed.json` is kept, not deleted. The picker does not re-read the switch on every keystroke: creating
`state/observe.off` while a picker is open takes effect at the next open (or the next change of `observed.json`).

Two environment variables exist for shells and tests. They stop only the child launch; the overlay file is still
read and drawn, so they are not a way to turn the display off:

| Variable | Effect |
|---|---|
| `UW_OBSERVE=0` | the picker starts no catch-up child |
| `UW_OBSERVE_NO_SPAWN=1` | same, for tests and QA (read the overlay, never start a child) |

The picker is started by a Claude Code wrapper, so these apply only when set in the shell that starts Claude Code. Use
`--off` for a lasting switch. (`UW_PICKER_QUIT_IMMEDIATELY=1`, used by the startup benchmark, also blocks the launch.)

#### Probe tagging

Every request the sweep and the confirmation probe send (`probeOne`) carries the header `x-ccr-client: uw-probe`. The
router records that value as the row's `client` in its usage log and removes the header before the request is forwarded
to the provider; this was verified live. The recorder skips every row whose client is `uw-probe` (counted as `probe` in `--status`), so
UW's own probes are never mistaken for your real use, and a confirmation can never trigger a confirmation. Before the tag
existed there was no way to tell probes from real requests (of 69,633 usage rows read on 2026-09-30, 69,557 were
`Profile: Claude Code` and 76 were `Local Gateway`), which is why the first run never reads old, untagged history: with no
watermark it starts at the first tagged row inside the last 3 days, and with no tagged row at the current last row.
To check the tag yourself, see step P22a in `docs/qa-interactive-protocol.md`.

Untagged scripts that call `/v1/messages` (some `keysync/` and `harness/` dev scripts) are indistinguishable from real use, so
their successes and failures can appear as live records (issue #135; tag each when it is next edited).

#### What is recorded: the status rules

Rows come from the router's usage table, named columns only. Two things are always dropped and counted, never stored:
client `uw-probe`, and a row whose completion time is more than 5 minutes ahead of your clock (`skew`).
A model key is `provider/model`; if that is not a route in the picker's snapshot and the model already starts with
`provider/`, the prefix is stripped and tried again (this keeps nvidia, whose real ids start with `nvidia/`, right,
and joins an Anthropic model that appears as both `claude-x` and `anthropic/claude-x`). A row with no matching route is
dropped (`unknownKey`).

| Router status | Picker class | Rule |
|---|---|---|
| 200 with at least 1 output token | `ok` | Proof of life. A 200 with 0 output tokens is ignored (`zeroTok`): providers deliver notices that way. An `ok` over an already-`ok` record writes nothing (`okSeen`). |
| 429 | `rate` | Hard signal: recorded at once. `pay` instead when the provider's text says the account is empty. |
| 402 | `pay` | Hard: at once. |
| 401 | `auth` | Hard: at once. |
| 403 | `auth`, or `pay` when the text says so | Hard: at once. |
| 404, 410 | `gone` | Hard: at once, with the provider-wide guard below. |
| 500, 502, 503, 529 and other 5xx | `error` | Ambiguous: needs the two-failure rule. |
| 504, 522, 524 | `timeout` | Ambiguous: same rule. A gateway-made 502 with an empty body counts as an ordinary ambiguous failure. |
| 400, 413, 422 | ignored (`ignored400`) | Invalid request, tool schema, context too long: not the model's health. A hard class is taken only from a TIGHT anchor in the failure text (below). |
| 499 | ignored (`abort499`) | The client gave up. |
| any other status | ignored (`otherStatus`) | |

A **tight anchor** is a phrase that names the account or the model, not the request: an empty balance said in words (`pay`),
an account-state sentence such as "no longer available to new users" (`auth`), or a strong "this model is gone" phrase or
the provider's machine code (`gone`). Loose words such as "rate limit" or "balance" are not enough on a 400 or a 5xx,
because a validation error can quote your own prompt or a tool name. A 5xx worded as throttling stays an ambiguous failure.

**The two-failure rule (5xx and timeouts).** A model is marked `error` or `timeout` only when the same key has two
ambiguous failures that are at least 2 minutes apart, no more than 24 hours apart, with no 200 for that key between them.
A second failure under 2 minutes after the first is a retry burst (Claude Code retries by itself) and is not counted
(`retry`). The first failure waits in `pend`; a `pend` entry older than 24 hours is dropped, and a later failure over 24 hours
after it starts a fresh one. A hard signal or a 200 clears `pend` for the key. When the rule is met the record's `m` reads
`2 failures >= 2 min apart, no 200 between: HTTP <status>`. The reason for the 2-minute gap: of 854 same-key consecutive 5xx
pairs in the router's usage log (measured 2026-09-30), 37% were within 60 seconds and 44% within 120 seconds.

**Guards.**

- *Gateway outage:* ambiguous failures spanning at most 60 seconds across 3 or more different providers, with no `ok` within a
  minute of that span, are the gateway or the network failing, not the models. They are dropped (`outage`).
- *Provider-wide 404:* 404s on 3 or more different models of one provider in a single run, with no 200 for that provider in the
  run and no provider sentence, look like a wrong path or base URL. They are downgraded to ambiguous `error` (`m` reads
  `404 across N models of <provider>: path or base URL?`), but only if that provider had an `ok` (probe or live) in the last
  14 days; otherwise the 404s stay `gone`. (Of 954 keys that ever returned 404, none later returned 200, so a removed model
  does not come back; the guard exists only for a wrong path on a provider that recently worked.)
- *Same class again:* a hard failure with the same class and sentence as the current record, within 6 hours of it, writes
  nothing (`dup`). An event not newer than the current record is `stale`. A request id seen twice counts once (`dupId`).
- *Order:* events in one run are sorted by completion time (start plus duration), then row id, because the router can insert older rows with new ids.
- *Anthropic subscription route:* rows with provider `anthropic` are observed like any other (a 429 usage limit is meaningful) but
  never trigger a confirmation probe (it would spend subscription quota).

**Watermark.** The catch-up reads rows with `id > watermark` in batches of 5,000, stops after 1.5 s or 100,000 rows (the next open continues), and
stores the last row id it examined, so passed-over rows are read once. If the router's table is reset (the stored id is above the current
maximum, the row at that id has a different time, or the router's sequence went backwards), the run starts again like a first run;
`--status` says so (`the last run re-initialised it`) and records are kept.

#### The confirmation probe

A real 200 proves the model answered, not that it answered usefully (a provider can deliver a notice as a 200). When a model
whose current record (the newer of probe and live) was not `ok` answers with a real 200, the catch-up writes the live `ok`
straight away and may ask for ONE tiny probe of that model with UW's own prompt ("Say hello in 5 words.", 96 tokens, tagged
`uw-probe`, 45 s timeout, one attempt, through the gateway, streamed like a sweep probe). The catch-up decides and reserves; a separate detached child sends it.
A model with no earlier record is shown `ok` unconfirmed (no spend for an unknown), and a flip older than 1 hour is no longer confirmed.

| Gate (checked in this order) | Value | Counted as |
|---|---|---|
| no hand-back hold in force | 10 minutes after a child could not reach the gateway or found a sweep | `hold` |
| at most one probe per key | 6 hours | `capKey` |
| provider is not `anthropic` | never probed | `anthropic` |
| the key is a probeable text row in the snapshot | | `notRoutable` |
| no sweep running (`bench.lock` held) | | `sweep` |
| at most per catch-up | 3 | `capRun` |
| at most per UTC day | 10 | `capDay` |
| worst-case cost of the row | at most $0.01 (the `--economy` ceiling; free rows always pass) | `cost` |

The reservation (`conf`, `confDay`) is written in the same write as the record, before any child exists, so a slow or
crashed child, or a second picker, cannot cause a second probe of the same key inside the 6 hours. The child skips, and hands
its reservation back, when there are no gateway settings, `/health` does not answer, or a sweep started meanwhile; it then
sets a 10-minute hold (`confHold`) so every open does not reserve and release again. The probe's result overrules the flip:

| Probe says | Record becomes | Picker |
|---|---|---|
| `ok` | the probe's record, marked `v:1`, with its time, ttft, tokens and reply | lowercase `ok`, `[live+probe HH:MMZ] <the reply>` |
| `auth`, `pay`, `gone`, `empty`, or a 200 that was really a notice | that class, marked `v:1` | lowercase class, `[live+probe HH:MMZ] ...` |
| `rate`, `error`, `timeout` (a transient failure) | the live `ok` stays, unmarked | plain live `OK`; not re-probed for 6 hours |
| aborted, lock busy for 3 s, or a newer event replaced the flip | file left as it was | plain live `OK` after 2 minutes |

The `--catchup` output line `confirmation probes: requested N; not requested by reason {...}` shows what was asked and why not.
The spend is bounded even if tagging failed: 10 a day, 3 a run, 1 per key per 6 hours, $0.01 a row.

#### The overlay and how it merges

`state/observed.json` (schema 1, key order fixed). A live record is a bench record plus `l: 1`, `q` (the router's request id) and,
after a confirmation, `v: 1`. All times are epoch seconds; `a` is the request's completion time.

| Field | Meaning |
|---|---|
| `writtenAt` | when this content was written; moves only when the content changes |
| `feed` | `ok`, `warn:key-mapping`, `unavailable:schema`, `unavailable:missing`, `unavailable:locked`, `unavailable:node-sqlite` |
| `prov` | per provider row (`keyId`): baked `bench` counts, `benchFlags`, `benchAgeHist`, `live`, `liveOk`, computed with the picker's own `bakeBench` over the merged view |
| `wm` | the watermark: `{ id, seq, at }` |
| `tagId` | the first id of a `uw-probe` row seen |
| `models` | `provider/id` to a live record: `{ s, d, a, q, l:1, o }` for ok; `{ s, d, a, q, l:1, m }` for a failure; `cf`/`cfa` while a confirmation is pending; `v:1` after one |
| `pend` | the waiting first ambiguous failure per key |
| `conf`, `confDay`, `confHold` | confirmation reservations, the day's count, the hand-back hold |

Merge (`loadBench`, per model key): the record with the newer `a` wins; a tie goes to the probe; an overlay record older than the
probe is ignored and pruned; a probe record whose status is `skip` is not a measurement and never beats a live one; a record dated
more than 5 minutes in the future is ignored on either side. Pruning, on every write: keys no longer in the snapshot, records not newer than
the probe, records older than 14 days, then above 800 records the oldest; `pend` over 24 hours; `conf` over 7 days.

`observed.json` is written only when its content changes. Per-run bookkeeping lives in `state/observed.run` so the picker's mtime check does not
fire on every open. The reader is total: a missing, torn, over 4 MB, wrong-schema or hand-edited file reads as no overlay, never an error, and every
entry is rebuilt from a closed vocabulary.

#### What the picker shows

- **`stat` in UPPERCASE** (`OK`, `RATE`, `PAY`, `AUTH`, `GONE`, `ERR`, `T/O`, `EMPT`) means seen in real use after that row's last probe. It
  keeps the 4-column width and the status colour, and survives colour off. **Lowercase** means a probe measured it, or a
  confirmation probe verified a live result (`v: 1`).
- **`reply:`** leads with `[live 14:32Z] answered HTTP 200 in 1.2 s; no reply text is kept for real requests`, or
  `[live 14:32Z] worked live; confirming...` (only while a confirmation is pending and the flip is under 2 minutes old), or
  `[live 14:32Z] <the provider's sentence>` for a failure, or `[live+probe 14:33Z] <the probe's own reply>` once verified. Times are UTC.
- **Header:** `312 ok (2 live) (52%)`. `n` is the oks that came from real use and are not yet probe-verified (exactly the rows drawn
  uppercase `OK`); shown only when above 0, so the figure never silently mixes the two populations. The `id:` line ends with `live 14:32Z`, the newest
  live record merged into the screen, only while the overlay affects the screen.
- **Level 0 recount at open.** The child stores per-provider baked counts (`prov`). At open the picker reads only `observed.json` (never
  `bench.json`, about a millisecond) and, when its `writtenAt` is strictly newer than the snapshot's `builtAt`, lays those counts over the provider rows, so
  level 0 and level 1 agree. A snapshot built after the overlay already contains it (`node menu/snapshot.mjs --build` bakes it in).
- **Age is probe-only.** `oldest probe`, the age histograms and the outdated notice read probe stamps only. The `probed` cell of a live row shows
  the age of its live observation.
- **One feed note line** above the footer (the outdated notice takes its place when both apply): `live feed unavailable (schema changed)`,
  `live feed unavailable (no router data)`, `live feed unavailable (no node:sqlite)`, `live feed: key mapping changed`, or
  `live feed: locked, showing the last update HH:MMZ`. It says the feed is not trustworthy; probes are unaffected.
- **Reload.** The picker stats `observed.json` once per keystroke; on any change of its mtime it re-reads the overlay and re-applies it in place (cursor,
  level and filters stay). A file that exists but does not read (torn, mid-rename) keeps the previous state and is retried on the next keystroke.

See `docs/visual-design.md` for frames generated by the real renderer.

#### Files and paths

| Path | What | Written by |
|---|---|---|
| `state/observed.json` | the overlay | the catch-up, and a confirmation child, both under `observed.lock`; the picker only reads |
| `state/observed.run` | last run time, examined and skip counts, last error, feed | every non-dry run that the kill switch does not stop (stamped first, so even a crash moves its mtime; the launcher throttles on it) |
| `state/observed.lock` | single writer lock; a dead holder or a lock older than 3 minutes is taken over | the writers |
| `state/observe.off` | the kill switch | `--off` / `--on` |
| `state/observed.json.tmp-*` | debris of a killed write; swept after 5 minutes | nobody (swept at child start) |
| `usage.sqlite` in the router's data directory (next to `service.json`; `UW_CCR_DATA_DIR` overrides the directory) | the router's usage log | read-only, by the child; `request-logs.sqlite` is read only when `request_logs` is not inside `usage.sqlite` |

The overlay is derived from the router's log and small (about 250 bytes a record, capped at 800), so it gets no history copies and can be deleted safely
(`--reset`). The launcher starts a child only when the last run started over 30 seconds ago (`observed.run` is stamped at the start of a run), `observed.lock` is absent or older than 2 minutes, and
its own process has not spawned in the last 30 seconds. The child is started with fixed arguments, no shell, no window, the repository as its working directory
and an allowlisted environment (`PATH`, system variables, `UW_*`, `CCR_INTERNAL_*`), not the picker's whole one.

#### Privacy

Stored: a status class, the duration, the output-token count, the time, the router's request id, and the flags `l`, `v`, `cf`. For a failure with status
401, 402, 403, 404, 410 or 429, also the provider's own error sentence, at most 160 characters, redacted (keys and key shapes, URLs, e-mail addresses and opaque
ids are masked). For every other failing status (400, 413, 422 and all 5xx) the fixed text `HTTP <status> (provider message not kept)`, because those bodies can
echo the conversation. A live `ok` carries no text. A confirmation probe stores the reply to UW's own prompt, like a sweep probe.

Never stored: prompts, replies, request or response bodies, headers, URLs, credentials, tokens. What the child reads: the named columns of the usage table
(`id, created_at, request_id, client, provider, model, status_code, duration_ms, output_tokens`) and, for failing rows only, the fields `$.error.message`,
`$.error.code`, `$.error.type` and `$.error.status` extracted inside SQLite from the response body (guarded by `json_valid` and a 256 KB size limit, at most 200 failing
rows a run), plus the two short gateway columns `error` and `gateway_error`. The body itself never enters the process, there is no prefix or raw-text fallback (a
body that is not valid JSON, has no `error.message` or is too large gets the fixed text), and the complete sentence is used in memory only to classify. Tests
assert the SQL text and that no `substr(response_body_text` exists under `refresh/`. Redaction runs on write and again on load;
`node refresh/bench-cli.mjs --redact` also redacts `m` and any non-ok `p` in `observed.json` (under `observed.lock`; the overlay pass is reported as skipped if the lock is
held) beside the bench file and log.

#### Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| No uppercase rows, no `live` stamp, ever | it is off (`--status` prints `DISABLED`), or nothing you used changed status (`0 model record(s)` with `okSeen`), or the launch is blocked (`UW_OBSERVE=0` in the shell that started Claude Code) | `--status`; `--on`; unset the variable. An empty overlay is normal when everything you used worked. |
| `live feed unavailable (schema changed)` | a router upgrade renamed or dropped a column the reader needs (`id, created_at, request_id, client, provider, model, status_code, duration_ms, output_tokens`) | Nothing wrong is written and probes are unaffected. `--status` prints the missing column names on a line right after `feed:` (`usage_events columns missing: status_code, duration_ms`; at most 12 names), taken from the `missing` field of `state/observed.run`. The reader needs updating for the router's new schema; `--off` hides the note meanwhile. Records are kept but stop growing. |
| `live feed unavailable (no router data)` | `usage.sqlite` is missing: router not installed or moved, or `UW_CCR_DATA_DIR` points at the wrong place | Check the router's data directory; unset `UW_CCR_DATA_DIR`. The note appears only once an overlay exists. |
| `live feed: key mapping changed` | in one run over half of at least 10 non-anthropic rows matched no route in the snapshot: the router now writes provider or model names differently, or the snapshot is old | Rebuild the snapshot (`node menu/snapshot.mjs --build`); if it persists the key derivation needs updating. Unknown rows are only dropped, nothing wrong is written. |
| `live feed: locked, showing the last update HH:MMZ` | three runs in a row found the router's database busy (over 250 ms) | Usually clears itself on a later open. Nothing is lost; the watermark waits. |
| `live feed unavailable (no node:sqlite)` | Node without built-in `node:sqlite` (this machine runs v25.0.0) | Use a Node that has it. |
| `--status` says `last error: overlay-unreadable: EBUSY` (or `EPERM`) | antivirus or another process holds `observed.json` | The run is skipped, records and watermark are safe; the next open retries. |
| `--status` says `last error: no usable snapshot (...)` | the picker's snapshot is missing or old | `node menu/snapshot.mjs --build`. |
| `--catchup` prints `skipped (locked: another run holds the lock)` | another catch-up or a confirmation write is in flight | Wait a moment. A dead holder or a lock over 3 minutes is taken over by itself; delete `state/observed.lock` only if no `observe-cli` process is running. |
| A model stays `ERR` or `RATE` after you fixed it | a live record stays until newer evidence: your next real request that succeeds, or a probe newer than it | Use the model once, or re-probe: `node refresh/bench-cli.mjs --live --only provider/id --force`. |
| A model shows uppercase `OK` but returns notices | a 200 with output tokens can still be a notice | The confirmation probe overrules it (except `anthropic`, never probed); otherwise re-probe as above. |
| No confirmation probe ran after a flip | a gate refused it | `node --no-warnings refresh/observe-cli.mjs --catchup --dry` prints `not requested by reason {...}`; the reasons are in the table above. |
| Picker did not change after you fixed a provider | the first frame shows the previous run; the child starts at most every 30 seconds | Press a key a moment later, or reopen after 30 seconds. |
| `watermark re-initialised` in the output | the router's table was reset or rebuilt under the stored id | Expected once; records are kept and the run starts like a first run. |

#### Known limits

- Real traffic through non-Anthropic models is thin (2,402 non-anthropic usage rows between 2026-09-01 and 2026-09-28, many of them sweeps), so the
  signal is mostly the `anthropic` subscription route plus occasional free-model use. A value review will decide how much of the feed to keep (issue #139).
- The router logs only the final provider. With fallback routing on, a request that failed on one provider and succeeded on another is one row for the second.
  Fallback is off today; the plan (`plans/live-observer-plan.md`, risk 3) says where the attempt count lives.
- `request_logs` keeps roughly the last 1.5 hours, so older failures carry the fixed text instead of the provider's sentence (issue #134).
- The reader's SQLite calls are synchronous and cannot be interrupted, so the child's watchdog cannot cut one short; the 256 KB and 200-row caps bound them (issue #140).
- The spend caps (`conf`, `confDay`) live in `observed.json`, so `--reset` deletes them together with every live record and the feed position, and allows a fresh round of confirmations (issue #141).
- Detached-child behaviour on Windows: a real launch from the picker on 2026-09-30 spawned in about 13 ms, updated `state/observed.run`
  within about a second and exited cleanly. That the child opens no console window is reasoned from the spawn options (`detached`,
  `windowsHide`), not separately observed (issue #142).
- A 401 or 402 marks one model, not the whole provider (issue #136). There is no doctor line yet (issue #137).
- Untagged dev scripts count as real use (issue #135).

Issues: #126 tagging, #127 overlay, #128 usage feed, #129 classifier and rules, #130 confirmation probe, #131 picker, #132 `--redact` / `--status` / `--reset`, #133 docs, #138 kill switch, all in
`Osamious/ultimatewrap`; the follow-ups are the ones named above.

### 6g. Tool fidelity — does the model really handle tools? (issue #121)

The bench (6d) asks every model to say hello, with no tools. A model can answer that cleanly and still choke on the tool schemas a
coding agent sends, and the catalogue's `tools` flag is a claim, not a measurement. The tool-fidelity probe measures it: a few
requests per model through the gateway, the same way the bench does, with the result kept in its OWN file `state/tool-fidelity.json`
(never in `bench.json` or the snapshot; the bench cannot overwrite it and it cannot change the bench).

| Level | What the request asks | Passes when |
|---|---|---|
| L1 | a SIMPLE call: the `fx_echo` tool with a plain short message ("hello"), the choice left to the model (`tool_choice` auto) | a `tool_use` block with valid JSON and the required argument. If auto yields no call, or the server refuses the auto choice ("auto" tool choice requires --enable-auto-tool-choice), the same request is asked once with the call forced (`fc`): a model that only calls when forced is class `t` at best. A strike is recorded only after the forced request was tried too. A call cut off by the output budget is no verdict (the budget is asked once more, larger) |
| L1 + argument fidelity (`1a`) | after L1 passed: an Edit-style call whose arguments are awkward (multi-line string, quotes, backslashes, unicode, an astral character, a nested JSON string, a boolean, an integer), the choice left to the model (forced as a fallback on no call) | every field comes back byte for byte (`af` p). A failure sets `af` f and `afw` ONLY: never a strike, never a lower class, never a failure of L1. A model that can call tools but cannot emit awkward content is class `t` with `af` f |
| L2 | a `tool_result` round trip; the result is about 20 KB and the fact the answer needs is at its END (`br`) | a final text answer that uses the fact, and no 400 |
| L3 | two requests: **3a** the constructs (a 58-character MCP-style tool name `nm`, a deep schema, `cache_control` on a tool `cc`; about 5 KB), then **3b** the large fixture (about 157 KB, about 40,000 input tokens, 44 tools) | 3a passes first; 3b is sent only after that. L3 passes when both are accepted and answered. A 3a pass alone is not an L3 pass |
| L4 | two parallel tool calls, asked inside the 3b request | two `tool_use` blocks with their own ids and valid, streamed arguments |
| big (5) | a fixture of about 400 KB (about 100,000 input tokens), `cache_control` on it | accepted and answered; a pass implies L3 (marked implied) |
| L6 spawn | the `Agent` tool: `subagent_type` and a prompt | a well-formed call (`sp`); sent only after L1 and L2 passed; two strikes; a failure never lowers the class |
| L7 error | a separate small request whose `tool_result` is `is_error` | the model reports the error and goes on (`er`) |

L1 and L2 always run together. **Default levels and order.** A normal run asks the BASELINE: L1, L2, then L6 (spawn) and L7 (the error result), the two cheap levels that need only L1+L2 (about 270 and 180 input tokens); `--levels 12` is L1+L2 alone, as before, and `--candidates` still defaults to all seven. Whatever order the levels are listed in, they run in COST order: 1 (with 1a), 2, 6, 7, then 3, 4, 5, so a cheap level is never held behind a big request. What a model learned is kept when a later level stops it (a limit, a timeout, an error): once L1 and L2 both have a verdict, the record is saved with what finished (the report counts these as partial), and NO pending reason is written beside it: the queue simply asks the missing level again (it also counts as recoverable in the verdict, see below). A flaky L6 or L7 (an error, a timeout, an empty answer: something about that request alone) is set aside, never blocks L3 or the big step, and is asked again by a later run; the model carries a deferral marker meanwhile: the pending reason `optional-flaky` with `since` and `rn` (it counts toward stuck at `rn` 3 or more) and the provider's words, not a growing `not-run`; a limit or an account state on L6 stops the model as before. The per-model request ceiling stays 12; the worst case (every L1-type request needing its forced retry, plus the cache_control retries of 3a and 3b) reaches exactly 12 without a timeout or an escalation, so one more makes the model pending `request-cap`. L3 and L4 are sent only to a model that passed L1 and L2 and only when you ask for them (`--levels 34`);
the big step only to a model that passed L3 (`--levels 5`; `--order big-first` below). A thinking block is not an answer: a reply that
only thought and ran out of output budget says nothing about tools and is tried again later.

A provider that refuses `cache_control` with a 400 that names it is recorded `cc: f` (the model is not failed) and the request is asked
again without it. A 400 that names the tool name is recorded `nm: f`.

**Free keys only (owner rule).** Only providers whose key tier is `free` are probed for tools AT ALL, at ANY level, L1 and L2 included. Providers
whose tier is `paid`, `free-deposit`, `management` or unknown are skipped entirely for now: they are not in the probe set, they get no request,
no record and no pending entry, and the ledger lists them as `excluded: not-free-tier (skipped for now)`, counted per tier (never an error).
The relay and any subscription tier stay `relay-by-provenance`. The rule is default-deny: an unlabelled provider, or a run with no tier data at
all (no compiled policy, no `--tiers-file`), probes nothing. It is enforced in three layers so no entry point can get round it (candidates,
`--sample`, `--only`, `--limit`, incremental, resume, `--retry-failed`, onboarding): the probe set is restricted to free-labelled providers
when the plan is made (`restrictToFree`), the queue is filtered again (`clampDeep`), and the engine (`probeModel`) itself sends zero
requests for a model whose tier is not free. A named model of a non-free provider is therefore not a way round it (`--only pb/b1` matches no
probe-ok model; `--allow` pins follow the same rule). The dry run reports the probe-ok models by key tier, how many were skipped, and the probe
set size.

**Lifting the rule (the same lift for every level).** It can be lifted only when ALL of these hold at once: `--include-tier paid` (or
`free-deposit`) names the tier, `--levels` is given explicitly, `--live` is given, the run printed the per-tier cost estimate, and
`--max-spend` is given explicitly (the dollar caps are in force). A lifted tier is probed at exactly the levels listed, L1 and L2 included:
lifting L1+L2 for the paid tier is the same lift as lifting the deep levels. Drop any one condition and the tier stays out of the probe set;
the dry run prints what is still missing. Management is never probed, lifted or not. No environment variable, config file, incremental run or
onboarding entry point lifts it.

**What a refusal means (classification).** A 400, 413 or 422 on a tool-bearing request is the model or its provider refusing the request itself: a verdict (a strike, see below) unless the provider's OWN sentence (read from `error.message`, never from a body that echoes a tool name or description) says one of these, each pending and never a strike:
- `pay`: an account state, also in words such as "wallet balance is insufficient, recharge at ...", "out of credits", "top up your account", "credit limit reached", "payment required". The provider is named in the report's attention block. A tool or schema name that merely contains `balance`, `recharge` or `purchase` is NOT an account state.
- `route-shape`: the route says the model must be called another way ("must be called via /provider/v1/messages", "wrong endpoint", "use /v1/...", "unsupported protocol"). The fix is in routing, not in the model. The report has a block `providers needing a routing fix` with the provider, how many models and the provider's words.
- `upstream-unavailable`: an AVAILABILITY sentence ("The selected model is temporarily unavailable. Try another model.", "Upstream request failed.", service unavailable, please retry, an internal error, overload, capacity), or a 400 that names nothing about the request (no schema, tool, parameter, format or similar word, e.g. "Upstream provider rejected the request"). The phrases every rejection carries ("provider rejected the request", "invalid request error", "Check the model, input, and parameters", a trace or request id) do not count as naming it, even though they contain words such as invalid, input and parameters. It is NEVER a verdict and never a strike toward x, however often it repeats (one request, no confirmation): the model stays untested and a later run asks again. The report has a block listing the provider, how many models and the provider's words. A sentence that also names the schema or the tool choice is a verdict. At the big step an unnamed 400 stays a size refusal (a cap, never x).
A first schema refusal is provisional (a strike) and the second at the same level confirms it, as before.

**Failures caused by the gateway (`xw`).** Some refusals are the gateway's own translation of the Anthropic request failing ("Function call is missing a thought_signature in functionCall parts", "Empty content is not allowed for assistant messages" for an assistant turn that has only a tool_use, "Tool call id was toolu_... but must be a-z, A-Z, 0-9, with a length of 9" for an id format the provider cannot take): a subagent would fail on turn 2 through this gateway, so the record stays `x` for routing, but it is tagged `xw: gateway` (it is not a limit of the model). The report and the dry run list them by provider with the provider's words ("failing because of the gateway's request translation"). After a gateway fix, `node refresh/tool-fidelity-cli.mjs --retry-failed --only-gateway [--live]` asks again just those (dry by default); a pass clears the tag.

**An empty or cut answer (what is a verdict).** An answer with no text and no tool call is judged on how it ended. It is NOT a verdict (inconclusive `empty`; the request is asked once more with 2,048 output tokens, then pending `reasoning-budget`) when the stop reason is max_tokens or the reported output tokens used 90 percent of the budget (some gateways translate "length" to "end_turn"). A stop reason that is a moderation or refusal ("refusal", "content_filter", "safety") is the provider's: pending `upstream-unavailable` with the stop reason as the hint. A stream that ends with neither a stop reason nor message_stop was cut: pending `error`, never a verdict. An empty answer that stopped normally with room left in the budget is a failure and the record keeps its shape in `l3w`. An empty answer to the 3a constructs request is asked once more WITHOUT the cache_control markers: when that answers, the markers were the cause (`cc f`, the level is learned, the later requests go without them); when it is empty too the markers are not blamed. At the 157 KB step, fewer than two parallel calls because the budget ran out is asked again with the larger budget, not recorded as an L4 failure.

**Cleaning old records.** `node refresh/tool-fidelity-cli.mjs --reset-transient [--live]` (dry by default; `--live` applies it under the lock, atomically) clears the records an availability or unnamed refusal produced (the failed pass is asked again: L1 and L2 together, L3 with the big step), tags the gateway failures `xw: gateway`, and clears argument-fidelity results whose reason came from the old test content (a path with an escape look-alike, an optional parameter left out), and reopens the L3 failures that rest on an EMPTY answer or unfinished call arguments (written before the stop reason and the budget were looked at: they are counted apart and asked again). The dry run counts per shape, kind and provider.

**Argument fidelity means "would corrupt a real Edit".** The test path is realistic (spaces, a non-ASCII letter, Windows separators, no newline, no escape look-alike); the awkward characters live in `old_string` and `new_string`. A path written with `/` for `\` passes; an optional parameter (`replace_all`, `start_line`) that was left out passes; a required field left out, or any change in a string, fails.

**What is stored (one record per `provider/id`, every field).**

| Field | Meaning |
|---|---|
| `lvr` | four letters, one per level L1..L4: `p` passed, `f` failed, `n` not run (only confirmed results) |
| `lv`, `t`, `ok` | derived from the fields below, never set by hand: `lv` the levels passed in a row (0, 1 for L1+L2, 3, 4); `t` the class `v` (L3 passed: verified at that size), `t` (L1 and L2 passed), `x` (failed), `u` (nothing run); `ok` whether the model is usable with tools |
| `why` | the first failed level's reason, redacted |
| `at`, `fx` | when it was probed; the fixture id the L3/L4 result was measured against (an older id earns the record a `*` and a re-sweep recommendation, never a re-queue) |
| `maxBytes` | the largest request the model ANSWERED. A lower bound; it never sets a payload cap |
| `alias` | a pool alias such as `auto`: it keeps its digit but compiles no higher than `u`, because the model behind that id can change |
| `big` | `p` or `f` for the 400 KB step; absent means not run. Not part of `lvr` |
| `capBelow` | bytes: the provider REFUSED a request of about this size or larger (an observed upper bound). The compiler lowers the model's payload cap `pb` to it, so big requests skip the model and small subagents may still use it. Written only for a refusal about SIZE (413, a body naming size or context length, any refusal at the big step), never for a rate or tokens-per-minute limit |
| `strikes`, `sl` | two strikes (below): the first failure at level `sl` (1, 2, 3 or 6) is provisional |
| `fc`, `af`, `nm`, `cc`, `br`, `er`, `sp` | one-letter `p` (passed) or `f` (failed) markers for the extra checks: `fc` L1 needed a forced call, `af` argument fidelity, `nm` long MCP name, `cc` cache_control accepted, `br` the fact at the end of the 20 KB result, `er` the error result, `sp` spawn. Kept OUT of `lvr`. They never change `lv`, `t`, `ok` except `fc`, which caps class `v` to `t`. `summaryOf(record)` in `refresh/tool-fidelity.mjs` turns a record into one printable line |
| `afw`, `l4w`, `l3w`, `spw` | what differed when a non-blocking marker failed, or what an unusable answer looked like, in at most 60 printable characters: `afw` for argument fidelity (`old_string: newline lost`, `file_path: backslash doubled`, `start_line: integer sent as string`, `old_string: unicode normalisation (NFC/NFD)`, `old_string: CRLF line endings`, `old_string: trailing whitespace changed`, `old_string: unicode escaped as \u`, ...), `l4w` for the parallel-call check (`1 call of 2 stop=tool_use`, `args not streamed stop=...`, `shared id or no arg stop=...`), `l3w` for a failed L3 (`stop=end_turn blocks=none in=40210 out=0`: the stop reason, the block kinds, the input and output tokens), `spw` for a failed spawn call (`text, not delegating stop=end_turn`). Never a verdict; cleared by a later pass; `summaryOf` prints them |
| `d3` | which part of L3 failed: `a` (the constructs), `b` (the 157 KB request), `i` (inconclusive) |

**L1 and argument fidelity are two requests.** Before this change one L1 request carried the awkward content, so a model that CAN call tools but emitted invalid JSON for it (or whose server refused the auto tool choice) was recorded as an L1 failure and a strike, and a second strike would have made it `x`. The records that came from that request say so in their reason; `node refresh/tool-fidelity-cli.mjs --reset-awkward-json` counts them (dry by default; with `--live` it clears them under the lock, atomically: a record that is otherwise unknown is removed so the next run asks L1 again with the plain call). It also clears strikes that came from an empty wallet or a route-shape refusal recorded before those readings existed.

**Argument fidelity is exact on purpose.** A real Edit finds its `old_string` only when it is byte for byte what the file holds, so a lost newline, CRLF, a doubled backslash, a different Unicode normalisation (NFC against NFD), trailing whitespace or a number sent as a string is a call that fails in use. Key order and fields the schema does not name do not matter. To learn WHAT a model mangled, ask L1 again for it: `node refresh/tool-fidelity-cli.mjs --force --levels 12 --only provider/model --live` (a handful of tiny requests); the record then carries `afw`.

**Two strikes.** A first failure at L1, L2, or L3 for a reason that is not size does not make a model `x`. The record keeps what it was
(a model never tested stays untested, a model that passed keeps its class), remembers the strike, and the next ordinary run asks that
level once more. A second failure at the same level confirms it: `x`. An L3 failure that is not about size, confirmed, is `x` too (the
model cannot take the real tool set). A refusal about size is never `x`: it sets `capBelow` and the model works for small payloads. A
pass clears the strike. A rate limit, an empty balance, a dead key, a 5xx, a timeout or an exhausted output budget is never a failure: the
model gets no record and stays queued. A route that says it has no tool support (even as a 404) is a failure.

**What the compiler does with it.** The class `t` is read as before. Inside class `v` the compiled order now also prefers a model whose
big step passed, then one that has not run it, then one that failed it; then the same for L4 (rank keys 4 and 5 of the explain output).
`capBelow` lowers `pb`. Nothing else changes, and class `t` and `u` rows are not reordered by these keys.

**Candidates: which models get the large requests.** L1 and L2 go to every probe-ok model of a free-labelled provider with no result (the ordinary run). L3, L4 and
the 400 KB step (for the models that pass L3) go, with `--candidates policy`, to EVERY probe-ok model on a FREE-tier provider (and only there: see the hard rule), whether or
not its context length is known. The tier is the provider's key tier: the compiled policy's `tiers` map (`state/subagent/policy.json`, or
`--policy-file` for a fixture) or `--tiers-file` (a `{provider: tier}` file, a policy, or the vault registry). Not tested for now, each
with its ledger reason: `not-free-tier (skipped for now)` (paid, free-deposit, management and unlabelled providers: see the owner rule above) and
`relay-by-provenance` (the relay and any subscription tier). `--include-tier paid[,free-deposit]` lifts an exclusion later (all five conditions); a
lifted paid model is charged as listed and the bench's row ceiling and spend cap apply. A model with a LISTED price on a FREE-labelled provider is
probed too (the provider's label governs, not the model's price) and is costed at that price under the same caps. Pins (`--allow provider/model,...`)
follow the tier rule like everything else: they bypass only the context-size exclusion.

*Size rules, so results stay meaningful.* A model whose KNOWN context is too small for the 157 KB fixture (about 39,000 tokens times 1.5
for tokeniser differences, plus the answer budget: about 59,000) is out with `ctx-too-small-for-fixture`. The 400 KB step is skipped, and
never recorded as a failure, when the known context is below 200,000 tokens (the dry run counts those). An unknown context is tested: a
context-length refusal at the big step is a size cap, not a failure.

*Order is a priority queue, never a limit.* Level 1: the compiled policy's allowed set with a known context of at least 128,000, plus
the pins (pins first). Level 2: the union of every preset's allowed set (dynamic and free in each scope, any context and 1M only, computed
offline with the policy funnel; if that cannot be computed the dry run says so and level 2 is empty). Level 3: other models with a known
context of at least 128,000. Level 4: unknown context. Level 5: known context below 128,000. Inside a level, the policy's own rank. The
per-provider token cap and the spend cap stop a run; the rest stays `pending: cap` and the next run picks it up. A candidate with no
L1+L2 result is asked those first, in the same run. The default levels of this mode are 1 to 7 (`--levels` overrides; on a key that is not free the engine clamps to 1 and 2, see the hard rule).

*The envelope.* The dry run prints the cost of the WHOLE queue at full depth before any cap (requests and input tokens, over how many of
the probe-ok models and providers), the per-provider cap that would finish it in one run (the largest provider's total), how many runs it
takes at the cap in force, and the smallest cap at which every model can run at all (a model that alone costs more than the cap never
runs under it: a full-depth model is about 147,000 input tokens, so the default cap of 150,000 just fits one; pass
`--tf-max-tokens-per-provider` to run more per provider). It also prints the cost of each request kind, the per-tier totals, the wall-time
estimate (a range, from provider latency and the in-flight rule below) and how many runs the whole queue takes at the default caps.

*The pilot.* `--sample [N]` (default 60; `--seed S`, default 1) draws a deterministic stratified pilot from the free-tier candidates: a
few per provider, in rounds so no provider is drawn twice before every provider once, mixing reasoning and plain models (judged from the
id: the snapshot has no such flag) and the context classes unknown, small (under 128,000) and large. It runs every level (L1 to L7; L4 rides in the 157 KB request), and the big step
for the models that pass; it never samples the big step. The dry run prints the strata counts and the estimate (about 40,000 tokens per model for L1+L2+L3,
the big step on top for passers); the report prints the L3 failure rate among the models that passed L1+L2, overall and per provider, so
the decision on promoting L3 and L4 to every model can be made on data.

```bash
node refresh/tool-fidelity-cli.mjs --candidates policy                                  # dry: the plan, the envelope and both ledgers
node refresh/tool-fidelity-cli.mjs --sample                                              # dry: the 60-model pilot
node refresh/tool-fidelity-cli.mjs --sample 60 --l3 yes --live --tf-max-tokens-per-provider 400000
node refresh/tool-fidelity-cli.mjs --candidates policy --l3 yes --live --tf-max-tokens-per-provider 400000
node refresh/tool-fidelity-cli.mjs --candidates policy --allow groq/some-model --l3 yes --live --tf-max-tokens-per-provider 400000
node refresh/tool-fidelity-cli.mjs --candidates policy --include-tier paid                # dry: what the paid tier would add and cost
```

**Safety limits and accounting (security round).**

- *Request ceiling.* No model is sent more than 12 requests in one run, counted together across every level, retry, the forced fallback, the thinking-only escalation and the `cache_control` re-ask. Reaching it ends the model as `pending: request-cap` (never a verdict, never an error). The `cache_control` re-ask happens once, and only when the failing request actually carried the marker; a model recorded `cc f` starts with the markers off.
- *Free key, listed price.* A free-tier KEY does not make a LISTED price free. A model with a listed price (price above 0 and no free tag) is costed at it, so `--max-row-cost` (default $0.10) and `--max-spend` apply: one over the ceiling is `pending: priced-over-row-cap` (counted, never an error) and `--max-row-cost` raises it. The deep-probe rule still goes by the key tier. The dry run prints how many free-keyed models carry a listed price, the dollars at full depth, and how many are over the ceiling. A free-keyed model with no listed price, or a free listing, costs nothing. The provider's label governs whether a model is probed; the model's price only governs what it costs.
- *Which tier a provider has.* The same effective tier the policy compiler uses for the chosen key. The compiled policy's `tiers` map is the compiler's own answer (the default source). A `--tiers-file` holding the vault registry (an array of rows with `id`) is resolved the way the compiler resolves it: a management key is ignored when the provider has another; one key gives its tier; several keys give the tier of the key the OWNER CHOSE (`--key-choices-file`, a `{provider: key id}` file, the compiler's key-choices). Only where no choice resolves it (none recorded, or one that names no usable key) keys of one tier give that tier and keys of DIFFERENT tiers give the MOST RESTRICTIVE tier (management, subscription, paid, free-deposit, free); the provider is then listed as a fallback. The result never depends on the row order. A tier outside the vocabulary leaves the provider unlabelled (default-deny). The dry run shows, per provider with several keys, which key and tier was chosen and why, and lists the providers that fell back.
- *Tier source and age.* The dry run and the report print where the tiers came from (the policy file or the tiers file), when it was compiled (or last modified) and how old that is, how many providers of the probe set the map does not cover (they count as not free), and a WARNING when the map is older than 2 days or covers too little.
- *The lift preview.* `--include-tier` prints, in every run (dry too), what lifting would cost per tier as if `--live` were given. The lift counts that line as shown only when it is in the printed plan; without it the paid tier stays clamped.
- *Spend.* Charged per request that was billed, from the usage the answer reported (the estimate when it did not): a part-finished level, an all-thinking answer and the larger-budget request asked after it count; a rate limit, a dead key or a server error cost nothing.
- *Error bodies.* A refusal body is read in chunks and cancelled after 2 KB.
- *File size cap.* When the state file passes its size cap the provider's sentences (`why` of the pending entries: the non-stuck models' first, oldest first, the stuck models' last; the run summary says how many) are stripped first, then the oldest records (models that left the catalogue first) are dropped; the report says how many and why.
- *The side file.* When the final save fails the records go to `state/tool-fidelity.unsaved.json`. `node refresh/tool-fidelity-cli.mjs --merge-unsaved` counts what it holds (dry); with `--live` it takes the records the state file lacks or has older, saves under the lock and only then deletes the side file.

**Scheduler and cost rules (every one measured, none lowers what is learned).**

- *Small output budgets.* Each request kind asks for few tokens: 256 for L1, L2, 3a, 3b and the error result, 512 for the big step and spawn. A reply cut by the budget is asked again once with 2048 (see below).
- *Stream cut.* The stream is cancelled once every expected `tool_use` block is closed and the usage was seen; the dry run counts these as `cut early`.
- *Timeouts are adaptive.* Each model's timeout is 3 x its own bench total time (`d` in `state/bench.json`, read only), clamped between a floor and a cap per request class: small requests (L1, L2, 3a, spawn, the error result) 45 s to 120 s, the 157 KB request 90 s to 180 s, the 400 KB request 120 s to 240 s; a model with no bench time gets the floors. The floors are `--timeout-small`, `--timeout-157`, `--timeout-big` and the caps `--timeout-max-small`, `--timeout-max-157`, `--timeout-max-big` (seconds). A timeout is asked ONCE more in the same run at DOUBLE the time (it counts toward the 12-request ceiling, is charged nothing, and the model's later requests keep the doubled time). A second timeout at the doubled value on L1 makes the model `pending: slow` (counted apart in the ledger and the report with the seconds it was given; the scheduler moves on); on any other level it is `pending: timeout`. A timeout is never a verdict. The dry run prints the factor, the floors and caps and this run's range.
- *In flight.* One request at a time per provider for requests of 100 KB or more, otherwise two; eight in all. A 429 is retried after the `Retry-After` time (at most 60 s); three 429s in a row pause that provider for the rest of the run (pending `rate`).
- *Canary, holds and providers needing attention.* A provider is paused (and HELD) only on EVIDENCE: `auth` is the key's state, so the first answer decides; `pay` needs two distinct models out of credit and none that answered; `gone` needs FOUR distinct models gone and none that answered (the first four asked are spread over the provider's queue: the first, the middle and the two quarter points). A provider that has CONFIRMED results from an earlier run (class t or v) is never paused or held for `pay` or `gone`: those are answers about models there, so the model is pending `pay` / `gone` and the provider goes on (an `auth` hold stays). A hold in the file for such a provider is ignored by the queue, and `--reset-gone-holds` removes it from the file. A paused provider gets nothing more in this run and is written to the file (`held`, `{provider: {r, at}}`, additive, at most 500); the next runs do not ask it at all, not even a canary. A hold is STICKY: it never expires by time (`--hold-hours N` is an opt-in expiry, off by default), see the next bullet. `--retry-accounts` forces held providers back in; a provider that answers is released; `--release-holds a,b` takes named holds off (dry by default, `--live` applies it under the lock, atomically; the `canary-*` pending entries of a released provider go too, and for a provider the owner NAMED, its models pending `pay` / `auth` / `gone` too). The report lists a block `providers needing attention`: the provider, its state, how many models were skipped and that it is held until lifted. It is an account state, not a verdict.
- *The sweep is a loop: run, stop at saturation, resume for what is recoverable (owner rule 2026-10-06).* Run passes; stop when a pass is saturated; run again later only for what a re-run can change. **Recoverable** blockers: rate, error, timeout, cap, spend, request-cap, empty, slow, reasoning-budget, upstream-unavailable, not-run, first-strike. **Hard** blockers (`pay`, `auth`, `gone`) are non-recoverable by the engine: a hold never expires by time, and a model whose stored pending reason is `pay`, `auth` or `gone` (also `canary-*` of them) is NOT queued by a normal run, with or without a hold (a `canary-pay` / `canary-gone` of a provider that has confirmed results is not hard: that provider answered). A model with a result is never asked again by a normal run (a first strike is the one exception: it is asked again). Only a manual action lifts a hard blocker: `--recheck-hard pay,auth,gone[,provider,...]` (after you charged credit or rotated a key; reasons narrow it, providers narrow it; a provider alone means all three reasons; a model or provider that answers again is cleared as before, and a provider that answers also loses its stale `auth` and `canary-*` entries), `--retry-accounts`, or `--release-holds a,b --live` for a named provider. **Naming ONE model is a manual act too:** `--only provider/model` (an exact model id) lifts that model's own hard block (a stored `pay` / `auth` / `gone`, or its provider's hold) and asks it, printing `provider/model: hard-blocked pay since <date>; asking it because you named it`; `--only <provider>` alone lifts nothing. `--force` and `--retry-failed` do not lift them. Reasons that need the owner (`route-shape`, `row-cost`, `priced-over-row-cap`, `cap-too-big`) are counted apart as NEEDS-OWNER and are not queued by a normal run (zero requests): `route-shape` while it is the stored reason, `row-cost` / `priced-over-row-cap` while the model is still over the row ceiling (raise `--max-row-cost` and it runs), `cap-too-big` when the model's own estimate is above `--tf-max-tokens-per-provider` (raise it; it is worked out again each run); `--recheck-hard owner` or naming the model with `--only provider/model` asks them (`--retry-accounts` does not: it is about accounts), each reason with its count and what you must do (`row-cost` / `priced-over-row-cap`: raise `--max-row-cost`; `route-shape`: fix the route): a re-run alone changes nothing.
- *The verdict and the stop signal.* The dry run and the end of every live run print `sweep verdict: RECOVERABLE n of N (reason counts) | HARD-BLOCKED m of N (pay x, auth y, gone z; lift only with --recheck-hard/--release-holds) | TESTED t of N`, where N is the models of the ledger(s) that are not excluded (a model in both ledgers counts once, the worst state wins), followed by a `population:` line with the excluded count and a line `of which tested at L1+L2 (a record with both verdicts): RECOVERABLE k of n, HARD-BLOCKED j of m` (the denominators are the two figures above it); with nothing recoverable it prints `DONE: nothing recoverable left`. A TESTED model that still lacks a level the run asks for (spawn and the error result by default; levels 3 to 5 only when `--levels` asks for them and the model is eligible) is not finished: it counts as RECOVERABLE (`optional-not-run`, or the reason of its pending entry such as `optional-flaky` or `rate`; HARD-BLOCKED when its provider is held), so a default dry run over models tested only at L1+L2 prints RECOVERABLE n and never DONE, and a non-empty queue never prints DONE. A live run adds `saturation of this run: R request(s) sent: X ended rate-limited (p% of R), Y ended rate, error or timeout (q% of R); K new record(s); saturated: yes|no`. Saturation is DIMINISHING RETURNS, not "everything is blocked": the tested total converges and each pass adds little. `saturated=yes` with one of these reasons: `done` (nothing recoverable is left), `zero-new` (the run recorded no new record), `failing` (at least 80% of its requests ended rate, error, timeout, quota or empty: a thinking-only answer), `diminishing` (the last `--saturate-runs` runs of THIS scope, this one included, each added newly tested models under `--saturate-gain` percent of their tested total AND (newly tested + deepened) under `--saturate-yield` percent of the models they asked; defaults 2 runs, 1%, 5%), `scope-exhausted` (the run sent nothing because nothing is queueable under its scope), and, only as a fallback while the scope has no run history yet, `no-shrink` (the recoverable set did not shrink against the previous run's). `newTested` counts models that went from not tested to tested in the run (any class, x included; a provisional first strike does not count, resolving one does; a partial record does: its L1+L2 verdicts are what make the model tested) and `deepened` tested models that gained a level the run asked for. For `diminishing` and `failing` the run prints the next action: a rate-limited or over-quota share of 50% or more of its requests says `resume later when rate limits clear (N recoverable)`; when most of the models the run asked produced no record at all (more than 50%) it prints `starved: N of M asked models produced no record (empty/rate/...)` and the resume-later action, never `converged`; otherwise `converged: the N remaining recoverable models are stuck (error/timeout/quota/optional-flaky); a re-run is unlikely to change them, review them`. A trend line shows the last runs: `last runs: +52, +14, +6 newly tested (of 950 tested now; 5.5% 1.5% 0.6% of each run's own tested total), asked 300/280/260 model(s), deepened ...`. The LAST line is machine-readable: `SATURATION saturated=<yes|no|unknown> recoverable=<n> hard=<m> new_results=<k> requests=<n> reason=<done|zero-new|failing|diminishing|no-shrink|scope-exhausted|queued|none|unknown>` (`unknown` with `reason=queued` in a dry run whose queue is not empty while nothing is counted recoverable, such as `--force`; `unknown` in a dry run with something recoverable, in a run that was interrupted or stopped early, and in the ledger-error fallback; `requests` is the number of requests the run sent). A loop script runs `--live` passes and stops on `saturated=yes`, waits, and resumes; it is finished for good when `recoverable=0`. The loop rule: stop on `saturated=yes`; on `unknown` run once more and stop if that run says `requests=0`. **Soft but stuck:** error, timeout, empty or slow as the stored reason for 3 or more runs in a row (`--pending-runs`) stay recoverable but are counted apart (`of which STUCK k`). The history is kept in an additive `meta` block of `state/tool-fidelity.json`: `{recoverable, scope, at, history}`, where `history` holds the recorded runs, at most 5 per scope and 12 in all, `{at, scope, asked, newTested, deepened, rateShare, testedTotal, recoverable}` (each scope compares only its own runs, so a plain loop and a `--candidates` loop that alternate each build their own series; a lift, a named model, a forced or retried pass, an interrupted run and a run that sent nothing are not recorded and do not touch it; `--release-holds` keeps it). The `no-shrink` fallback uses the meta's own count ( `scope` is a stable hash of the flags that decide which models the count is about: `--candidates`, `--sample` and `--seed`, `--only`, `--include-tier`, `--allow`, `--levels`, the policy and tiers files; `--limit`, caps and lifts are not in it), and the next run compares ONLY under an equal scope. A run that is a manual lift (`--retry-accounts`, `--recheck-hard`, a named model lifted by `--only provider/model`) compares nothing, a meta block without a scope reads as no previous count, and `--release-holds` / `--reset-gone-holds --live` clear the meta block unless it holds a run history, which they keep). Malformed history entries are dropped when the file is read. **Run counts:** a pending entry also carries `rn`, the runs in a row with THIS reason (it restarts at 1 when the reason changes; a legacy entry reads as `rn = n`); STUCK and the verdict read `rn`, while `n` (every run) is unchanged because the funnel reads it. **The provider's own words:** an entry also carries `why`, the sentence the provider gave, clipped to 120 characters and redacted, so every block can be audited. **Dates:** every pending entry carries `since` (the first time that reason was recorded; an older entry reads as since its last time), the ledger rows carry it with the run count, and the verdict prints `oldest since, per reason` so you can judge the cool-down. **Completeness:** `TESTED t of N (complete for every level it is eligible for c of t; tested but optional levels not run u of t: L4 a, big b, spawn c, error-result d)`; this splits the tested figure, it does not change it. A live run that sends nothing prints the same lines (`saturated=yes`, `new_results=0`). Exit codes are unchanged. A run that is NOT a full measurement says so: a live run that sent nothing because nothing is queueable under its scope prints `saturated=yes` with a note `scope-exhausted: N recoverable model(s) are outside this run's scope/levels` (a loop on that scope should stop), and a run that was interrupted (Ctrl-C) or stopped early (`--max-minutes`, an outage) prints `saturation: not judged`, `saturated=unknown`, no `DONE` and writes no meta block. If the ledger itself could not be built the last line is the fallback `SATURATION saturated=unknown recoverable=unknown hard=unknown new_results=<k>`.
- *Order of the sweep's filters, quota, and what releases a hold.* The queue is built in this order: `--only` (the scope), then what is blocked (held providers, hard pending, NEEDS-OWNER), then `--limit` (and `--sample` draws only from models that can be asked), so a blocked model never takes a place of `--limit` or `--sample`. **Quota is soft:** a bare quota sentence (`quota`, `daily limit`, `per day`, `limit reached`, `allowance`) without money words (wallet, credit, balance, recharge, top-up, payment, funds, billing, plan) and without a rate or wait wording (`rate limit`, `per minute`, `try again in 20s`) is the reason `quota`: recoverable, counted as stuck at `rn` 3 or more, shown with its `since`, and never escalated to `pay` by itself (the owner decides); HTTP 402, `recharge`, `top up`, `insufficient balance|credits|funds`, `wallet`, `payment required`, `credit limit` and a sentence that names the `billing` or the `plan` stay `pay` (so `insufficient_quota ... check your plan and billing details` is `pay`); the same bare sentence on a 403, which would read as `auth`, is `quota` too (a hold for "daily limit reached" would be wrong), while real auth words (invalid key, unauthorized, forbidden key) stay `auth`. A provider answering `quota` three times in a row is left alone for the rest of the run with no wait (`quota exhausted`), its other models pending `quota-paused` (never asked: a model keeps the reason it had, and `quota-paused` never counts toward stuck). The same holds for a provider paused on RATE limits: the models it never let in are `rate-paused` (or keep the reason of their last real ask), unchanged run after run, never counted in `n` or `rn`, never stuck, and ignored by the policy funnel, which reads only the real `rate` / `quota` answers; no hold is written for it. The verdict prints one `stuck on <provider>: "<its own words>"` line per stuck provider. **A 402 with an availability-only sentence is not a pay:** HTTP 402 is `pay` by its status, but when the provider's own sentence says only that the upstream was unavailable (`anymodel: Upstream request failed.`, `temporarily unavailable`) and has no money word (wallet, credit, balance, recharge, top-up, payment, funds, billing, plan), the answer is `upstream-unavailable` (soft, asked again, the sentence kept in `why`), never a sticky `pay` and never evidence for a provider hold; a money word keeps it `pay`. 401, 403 and 404 with such a sentence are still read by their status (auth, auth, gone). `--reset-transient` (dry by default, `--live` applies it under the lock) also drops the pending `pay` entries whose stored sentence is availability-only and has no money word, so those models are asked again; `pay` entries with no stored sentence (written before `why` existed) are lifted by hand with `--release-holds <provider> --live`. **Wrong credentials are `auth` at any status:** a refusal whose own sentence says the key or token is wrong (`invalid API key`, `incorrect API key`, `unauthorized`, `authentication failed`, a missing or expired key, token or credentials) is the account's state even as a 400: never a schema strike and never an answer that releases a hold. The sentence must START with that phrase and the phrase must be its whole subject (`Invalid API key provided.`, `Unauthorized`); on a 400 or 422 it is evidence about THAT MODEL only (the model is pending `auth`, and the provider is held only on two distinct models with no answer, like pay), while a 401 or 403 keeps the first-answer rule; a schema sentence that merely contains the word key (`unknown key in properties`) is not matched. **A hold is released** when the provider ANSWERED in the run: any verdict record for it (t, v or x: a model with no tool support is still an answer) clears the hold and its stale `auth` / `canary-*` entries (`holdIsWrong`, which ignores a pay or gone hold for a provider that has confirmed t or v results, is unchanged); a model named with `--only provider/model` releases only its own pending entry, never the provider's hold or its other entries. **After a key change** `--retry-accounts` or `--recheck-hard auth` is required: an `auth` hold never ends by time, and a normal run will not ask the provider. `--release-holds <provider> --live` also deletes that provider's `pay` / `auth` / `gone` / `canary-*` pending entries when no hold exists. A lift that the cap defers says `repeat the same --recheck-hard command to continue` (the lifted models stay blocked for a normal run). `--merge-unsaved` also folds the side file's `held` and `pending` (the newer `at` wins, and a model that got its record from the side file is no longer pending; an entry that exists ONLY in the side file comes back only if its `at` is after the state file's own last write, so a hold released since does not return). A first strike counts as recoverable only when the level it failed at is one of the run's `--levels`; otherwise it counts as tested and the verdict says so.
- *Models that already failed queue behind the ones never asked.* A model whose last ask ended without a verdict (rate, pay, gone, error, timeout, ...) goes behind the models that were never asked, ordered by how often it failed; a later `cap` wait does not erase that. Without this the same first few models of a big provider took the cap every run, failed every run, and the models behind them never ran.
- *Small-context models.* With `--candidates policy` a model whose known context is too small for the 157 KB fixture is out of the L3 candidates (ledger reason `ctx-too-small-for-fixture`) but is still queued for L1, L2, spawn and the error result, which fit any window.
- *The table of what is untested.* The dry run and the report print, per provider, why its models are untested: `held:state` (on hold), `paused:state` (paused by its canary in an earlier run), `cap` (waiting for the per-provider cap), `queued` (asked this run), or the stored reason (rate, pay, gone, error, not-run), tested and untested counts, and whether the provider can run now. It ends with how many untested models sit with a provider that can run.
- *Held providers leave the queue before the cap.* The dry run prints a block `held providers`: each provider, its state, since when, when it can be retried and how many queued models it frees, plus the input tokens of cap that were freed. The per-provider cap is applied only to the providers that can run, and the share of the held ones is re-split among them (at most twice the cap; the dry run prints the new figure). Models of held providers are their own ledger bucket `held` in both ledgers: never `pending`, never `pending too long`.
- *Rate limits are the moment's.* Three rate limits in a row make a provider wait out the Retry-After (at least 5 s, at most a minute) and be tried again in the same run; only a second such episode leaves it alone for the rest of the run (pending `rate`).
- *Old canary entries.* `node refresh/tool-fidelity-cli.mjs --reset-canary [--live]` (dry by default; `--live` applies it under the lock, atomically) clears the `canary-gone` entries recorded under the old one-answer logic so the two-model logic judges them again, and turns `pay` / `auth` / `canary-pay` / `canary-auth` entries into holds at their own time (not where a newer record exists).
- *The heartbeat is quiet about providers that are paused:* it prints counts (`paused: pay 2, gone 1, rate 1`), not names; the held ones are shown once, in the block at the start.
- *No repeats.* A confirmed level is never sent again (the dry run and the ledger count it as done).
- *Order.* `--order l3-first` (default) runs the 3a/3b pair and then the big step. `--order big-first` sends the big step first to a model with a known context of at least 200,000: a pass implies L3 (recorded `implied`), a failure then runs L3. The pilot report prints the expected cost of each order from the rates it measured.
- *Telemetry.* The run prints, per request kind and per provider, actual input and output tokens and seconds against the estimate, the total wall time and a calibration line (`no usage was reported by any request` when none did: a zero is not a measurement). A table lists each provider that timed out: timeouts, median and longest seconds, and how many models were pending slow, so a slow provider reads as slow, not as untested. It is printed, never stored.
- *Heartbeat.* Every 60 seconds a live run prints one line: elapsed time, models recorded and attempted of the queue, requests sent against the estimate with the timeouts so far, tokens reported so far against the estimate, the active providers, the paused ones (rate, canary) and, from the pace seen so far per request kind, how long the rest should take. Ctrl-C writes the finished records to the file first, then stops.
- *A priced run needs an explicit `--max-spend`.* A live run that has any priced model in its queue (a listed price counts, also on a free-labelled provider) is refused unless `--max-spend` is given, with the estimate in the message. A run with nothing priced in it needs none. **What a model is costed at:** on a key whose tier is `free`, a model with NO listed price costs $0 (like the free-tier models; the estimate line says `an unlisted price on a free-labelled key: $0` and counts them), so a sweep of hundreds of unlisted models is not refused at `--max-spend 5`; a model with a LISTED price is costed at that price and the `--max-row-cost` ceiling applies to it (over it, the model stays pending `priced-over-row-cap`). Paid tiers are untouched: they are not probed unless lifted, and a lifted run charges an unlisted price at the highest listed paid price of the whole probe set. The verdict names its labels: a model this run queues is never shown as `cap` (only the ones that wait for the cap now are), and `tested but optional levels not run: N of T model(s), G level gap(s)` counts models and level gaps apart (a model can miss more than one level).

**Thinking-only answers.** A reply that only thought and stopped at `max_tokens` is inconclusive. The first time it happens for a model
in a run, the same request is asked again once with 2048 tokens instead of its small budget (and that model's later levels use 2048). A pass after the
bump is a normal verdict; the report counts the escalated models. Still empty after the bump, the model is `pending: reasoning-budget`,
never failed.

**Coverage ledger.** Every model of a step ends in exactly one terminal state, and the dry run and the end-of-run report print the counts
with their denominators (`coverage L1+L2 ...` over every listed model, `coverage L3 ...` over the probe-ok models split into candidates
and excluded):

| State | Meaning |
|---|---|
| `tested` | has a result for the step: its tier (`v`, `t`, `x`) and the evidence (`pppp big p`, `ppfn cap<150000`) |
| `pending` | waiting, with the reason: `first-strike` (failed once, asked again, not yet `x`), a status from earlier runs (`rate`, `pay`, `auth`, `timeout`, `error`, `gone`, `empty`), `cap`, `spend`, `row-cost`, `queued` (this run will do it), `not-run` |
| `excluded` | out by rule, with the reason: `ctx-below-floor`, `ctx-unknown`, `outside-toggles`, `invalid-id`, `relay-by-provenance`, `not-probe-ok` |

`coverage()` in `refresh/tool-fidelity.mjs` builds the ledger and `assertPartition()` throws if a model is in no state, in two, or twice:
a model dropped by a bug is a loud failure, never a smaller denominator. Three capped lists follow the counts: models that failed once
(provisional, never reported as failed), models pending for `--pending-runs` runs in a row (default 3), and tested models whose record
is against an older fixture (`*`, a re-sweep is recommended and never automatic). The run counts live in an optional top-level `pending` object in
`state/tool-fidelity.json`: `"pending": { "provider/id": { "r": "rate", "n": 3, "at": "2026-10-05T10:00:00.000Z" } }`. `r` is a short code (`rate`, `pay`,
`auth`, `timeout`, `error`, `gone`, `empty`, `reasoning-budget`, `request-cap`, `priced-over-row-cap`, `slow`, `route-shape`, `upstream-unavailable`, `cap`, `spend`, `row-cost`, `not-run`; lower case, digits and hyphens, at most 24 characters), `n` the
number of runs in a row (1 to 9999) in which the model was in the queue and ended untested, `at` the last of them. It is bookkeeping, not a result: an entry goes away
when the model gets a result or waits on its second strike, entries of models that left the probe set are dropped, at most 5,000 are kept, it is counted in the
file's size cap, and the ledger ignores the entry of a model that is tested.

**Inheritance marks (data only; nothing reads them yet).** `inherited(key, store, catalog)` says what the records of OTHER providers imply
for a model that has no result of its own, so a planner can decide how to show it. A pass never propagates as a pass.

| Mark | When | Meaning |
|---|---|---|
| `likely-x` (`from`) | the same model has a CONFIRMED failure at another provider | probably cannot take the tool set; the real probe may still say otherwise (`conflict: true` when another provider passed) |
| `upper-bound` (level 3, `from`) | the same model passed L3 at another provider | at most that good, shown as `~3`; never a pass |
| `claim-only` (`prior: "c"`) | only the catalogue's `tools` claim | a prior, never eligibility; `prior: "c"` is also added to the other marks when the claim is true |

The helper returns null for a model that has its own confirmed result, ignores sources that failed once, alias rows, the same provider
and untested records, and takes `catalog = { identityOf?, toolsClaim?, resellers? }` (the default identity is the last path segment of
the id without a tier suffix; pass your own to use the catalogue's canonical ids). It is not wired into the compiler or the picker.

**Context length unknown** is reported as its own count (the dry run and the end-of-run line): a model with no listed context length is
not a failure, but the policy cannot rank it by context.

```bash
# Dry (the default): counts, request and token estimates, dollars, per-provider plan. Sends nothing, writes nothing.
node refresh/tool-fidelity-cli.mjs
# Live: L1+L2 for every probe-ok model that has no record yet. Free-tier providers first, then paid under the bench's row ceiling
# and spend cap, which this pass measures on INPUT tokens as well as output. One sweep at a time (the bench's lock).
node refresh/tool-fidelity-cli.mjs --live
# One provider, or one model; a sample (one model per provider first).
node refresh/tool-fidelity-cli.mjs --live --only groq
node refresh/tool-fidelity-cli.mjs --live --limit 40
# The large fixture and parallel calls: needs --l3 yes AND a named provider or an explicit cap. Level 5 is the 400 KB step.
node refresh/tool-fidelity-cli.mjs --levels 34 --l3 yes --live --only groq/some-model
node refresh/tool-fidelity-cli.mjs --levels 5 --l3 yes --live --only groq
# Ask again for models that already have a record (a re-sweep), or ONLY for confirmed failures (never touches a record that passed).
node refresh/tool-fidelity-cli.mjs --live --force --only groq
node refresh/tool-fidelity-cli.mjs --live --retry-failed --l3 yes --only groq
```

`--tf-max-tokens-per-provider N` (default 150,000 input tokens per provider per run) keeps a provider with hundreds of models from
spending its whole allowance at once: models past the cap simply wait, and the next run continues where this one stopped. A cap below the
cost of one model is reported with the cap that is needed (a warning in the dry run, a refusal live). A run refuses to start when its own
estimate is above `--max-spend`; a probe that stops part way is charged for the levels it completed. The dry run prints, with their
denominators, how many models are probe-ok, how many have a record, how many against the current fixture, how many failed once and wait
for a second try, how many `tools: false` models are in the set, how many have no listed context length, and how many are queued.

The first live run is the owner's decision (it spends real quota on free tiers and a little money on paid ones). Later runs for
newly discovered models follow the same caps. Nothing here is scheduled yet: `runIncremental` in `refresh/tool-fidelity-cli.mjs` is the
function a scheduler will call, and `requeueL3Failures` in `refresh/tool-fidelity.mjs` is the function to call after a provider's key
tier changes (a free key and a paid key can behave differently); it only returns the changed records and is not wired to `retier` yet.

Nothing in the tests can write the real state file: the writer compares against a `realFile` the tests set to a temp file, and the test
guard throws before any write under the real state folder. The records this version cannot read (a newer writer's fields, say) are kept
in the file on every save, not deleted.

## 7. Troubleshooting

- **The picker shows a `live feed ...` note, or a status in UPPERCASE you did not expect:** that is the live feed; see 6f (Troubleshooting
  table) and run `node refresh/observe-cli.mjs --status`. `node refresh/observe-cli.mjs --off` switches it off without a source edit.
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

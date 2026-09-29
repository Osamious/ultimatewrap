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

### 6c. Health — probe results feeding the picker's health column

The picker's health column (`ok` / `needs $` / `broken` / `stale`) is
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

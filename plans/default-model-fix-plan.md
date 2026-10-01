# Fixed default model (sonnet 5.5) that keysync never overrides

Status: PLAN ONLY, not approved, nothing implemented. Branch to use: `feat/default-model-fixed` (issue #74 deferral, 2026-09-07: "its own branch").
Date: 2026-10-01. Repo: `C:\Users\osami\.uw`. Authored by planner; must be reviewed by a different agent (critic) before execution.

OWNER REQUIREMENT (verbatim): "i want the default model i start every session to be fixed to sonnet 5.5, and i don't want keysync running to override it"

Target value (owner's hand edit, today): `anthropic/claude-sonnet-5-5[1m]`.

Denominators used below: "keysync run" = `node keysync/run.mjs` live profile-writing run (not `--no-profile`, not `--dry`). "Anchor" = `profile.claudeCode.model` / `settings.env.ANTHROPIC_MODEL`.

---------------------------------------------------------------------------------------------------

## 0. Verdict in five lines

1. Keysync does NOT write `ANTHROPIC_MODEL`, `CCR_CLAUDE_CODE_MODEL`, `CODEXL_CLAUDE_CODE_MODEL` itself. CCR's `saveConfig(..., {applyProfile:true})` writes all three, derived from `profile.model` (the value keysync puts there). Keysync only merges into the file afterwards.
2. Therefore the owner's hand edit of settings.json is not durable: the next keysync run (and, by CCR's own code, any later CCR-initiated profile apply) clears those three variables and re-derives them from the persisted `profile.model`, which keysync last set to the constant `anthropic/claude-opus-5`.
3. The fix must change the INPUT (`profile.model` in CCR's DB, set by keysync from an owner-owned data file) and then assert the OUTPUT (the three env vars) after CCR's rewrite. Re-asserting only the output would not survive a CCR-initiated apply.
4. Recommended design = candidate A (owner data file `~/.llmkeys/default-model.json`, small CLI, validated against the built picker, fatal-before-write on invalid, never a silent fallback). B is infeasible; C violates the "no source edit" pillar.
5. Consequence the owner must accept (Q1): a `/model` pick persists to `settings.model` but NEW sessions still start on the fixed default, because `env.ANTHROPIC_MODEL` wins over `settings.model` for new sessions (#74). A pick only lasts for the running session. That is what "fixed" means; it is the same behaviour measured today.

---------------------------------------------------------------------------------------------------

## 1. Findings: exactly which code writes what (every fact cited)

### 1.1 Keysync side (what keysync decides)

| Fact | Where |
|---|---|
| Constant tier anchors: `ANTHROPIC_TIERS = {model: anthropic/claude-opus-5, opusModel: anthropic/claude-opus-5, sonnetModel: anthropic/claude-sonnet-5, haikuModel: anthropic/claude-haiku-4-5-20251001, smallFastModel: same haiku, fableModel: anthropic/claude-fable-5-1}`. Exported, NOT frozen (must never be mutated by new code). | `keysync/keysync.mjs:993-1000` |
| Anchor resolution: relay live (`anthropicOn`) returns `tiers.model` with `via:"anthropic-tiers"`; otherwise first `ANCHOR_PREFERENCE` hit, then verified, then `picker[0]`. `resolveAnchor` already accepts an injectable `tiers` option. | `keysync/run.mjs:1105-1121`, `ANCHOR_PREFERENCE` at `keysync/keysync.mjs:1005-1012` |
| `anthropicOn` = relay `/health` ok and not `--no-anthropic`; relay rows are only added to the picker when true. | `keysync/run.mjs:1455-1470` |
| Tier set actually used: relay on -> `ANTHROPIC_TIERS` verbatim; relay off -> all six = anchor model. | `keysync/run.mjs:1751-1762` |
| Profile mutation (gated by `!--no-profile`): `p.model/smallFastModel/haikuModel/sonnetModel/opusModel/fableModel` and `cfg.profile.claudeCode = {...}` set from `tiers`. Comment: never leave `profile.model` empty ("bare Invalid API key"); CCR clears every model-alias env var on each apply. | `keysync/run.mjs:1773-1797` (comment 1779-1784) |
| Restart prediction mirrors CCR's predicate; `profile.*` and `Router.*` are explicitly NOT in it. | `keysync/safety.mjs:445-489` (note 456-460) |
| `--no-restart` gate computed before any restore point. | `keysync/run.mjs:1811-1826` |
| Restore points before write: settings backup `${SETTINGS}.uw-backup-<stamp>`, `config.sqlite` snapshot (live only). | `keysync/run.mjs:1828-1844`; `keysync/safety.mjs:13`, `:48`, `:76` |
| `saveConfig` (CCR rewrites settings.json here), then unconditional gateway health poll. | `keysync/run.mjs:1867-1890` |
| Keysync's own merge into the CCR-written file: read (BOM stripped) -> `stripOneMSuffix` -> `stripGatewayDiscovery` -> `reconcileUserModelPin` -> `modelPicker` -> `atomicWriteJson`. `settingsBefore` is an independent parse taken after CCR's write. | `keysync/run.mjs:1919-1928`, `:1931`, `:1952`, `:1992-2003` |
| Pin handling: `settings.model` is user-owned; kept if it names a picker row, cleared if stale; prints a NOTE when it differs from `tiers.model`. | `keysync/run.mjs:1952-1977`; `keysync/keysync.mjs:1864-1871` |
| Post-write verify + `assertSettingsInvariants`; any throw lands in the catch that restores settings from backup. | `keysync/run.mjs:2019-2031`, catch `:2033-2058` |
| `assertSettingsInvariants` owns only `modelPicker` and `model` at top level; `env` is not checked (only SECURITY_CRITICAL_KEYS are). So no invariant change is needed for env edits. | `keysync/safety.mjs:376-383`, `:401-421` |
| `stripOneMSuffix` strips `[1m]` from every env var value ending in it EXCEPT `anthropic/*` (legitimate on a model Claude Code knows). So the owner's `anthropic/claude-sonnet-5-5[1m]` survives it. | `keysync/keysync.mjs:1816-1826` |
| `settings.json` write: `JSON.stringify(obj,null,2)+"\n"` (LF, UTF-8, no BOM) to a temp file next to it, rename with 3 retries, destination DACL re-applied. Read side strips a leading BOM only. | `keysync/safety.mjs:550-585`; read at `keysync/run.mjs:1919` |
| Owner-data precedent: `~/.llmkeys/key-choices.json` replaced a hardcoded source constant specifically so adding a choice "is not a source edit"; read at runtime; absent file = none; CLI `key.mjs prefer` writes it with `writeAtomic`. | `keysync/keysync.mjs:71-88`; `keysync/key.mjs:73-78`, `:149-172`; `menu/atomic.mjs` |
| `readJsonOr` returns the fallback on ANY error including a corrupt file. (Must NOT be used for the new file; see 3.1.) | `menu/atomic.mjs:39-43` |
| Env-override precedent for a path/URL constant. | `keysync/keysync.mjs:977` (`UW_ANTHROPIC_RELAY`) |
| `--dry` writes only `keysync/built-rows.json` (array of picker model ids; gitignored) and `process.exit(0)` before any target/rpc/settings access. Picker (incl. relay rows) is final at that point. | `keysync/run.mjs:1517`, `:1617-1651`; `BUILT_ROWS` at `:69` |
| Entry-point guard: importing `run.mjs` does not run the pipeline; tests import exported functions or pin wiring by source order. | `keysync/run.mjs:1332`, closing comment `:2075`; test style in `test/no-restart-guard.test.mjs:1-40` |

### 1.2 CCR side (research copy `spike/research/ccr-scratch/claude-code-router-main`, `packages/core/package.json` version 3.0.22 = live `ccr-pristine/3.0.22`)

| Fact | Where |
|---|---|
| Managed env keys: `ANTHROPIC_MODEL`, `CCR_CLAUDE_CODE_MODEL`, `CODEXL_CLAUDE_CODE_MODEL`, `ANTHROPIC_DEFAULT_FABLE/OPUS/SONNET/HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`. | `packages/core/src/agents/claude-code/environment.ts:11-20` |
| `claudeCodeModelEnv`: if `selection.model` non-empty, sets ANTHROPIC_MODEL = CCR_CLAUDE_CODE_MODEL = CODEXL_CLAUDE_CODE_MODEL = that single value; alias vars from fable/opus/sonnet; HAIKU from `haikuModel || smallFastModel`. `ANTHROPIC_SMALL_FAST_MODEL` is cleared and never re-set. | `environment.ts:51-65`, clear at `:67-71` |
| `applyClaudeCodeProfile`: starts from existing `settings.env`, clears the 8 managed keys, then `Object.assign(env, claudeCodeProfileModelEnv(config, profile))`; `claudeCodeNextSettings` spreads the existing settings and replaces only `apiKeyHelper` and `env`. So `settings.model`, `effortLevel`, `modelSettings` and every other top-level key are untouched by CCR. | `packages/core/src/profiles/service.ts:387`, `:420-421`, `:1187-1204` |
| Model selection fed to that env builder: each of the six values passes through `claudeCodeOneMillionContextModel`: if it already ends in `[1m]` it is kept as-is; otherwise `[1m]` is appended iff CCR's auto-compact window for that id is >= 1,000,000. | `service.ts:2218-2244` |
| The same derivation runs on any CCR-initiated apply (not only keysync's). It reads `profile.model` from CCR's persisted config. | `service.ts:2210` (runtime env), `:420-421` |
| CCR's own launcher uses raw `profile.model`. | `packages/core/src/profiles/launch-service.ts:1331` |

### 1.3 What Claude Code needs (client side, from the repo's own measurements)

- `env.ANTHROPIC_MODEL` beats `settings.model` for NEW sessions (#74 body + comment 2, narrowed 2026-09-09: mid-session `/model` does reach the wire; Claude Code now prints "ANTHROPIC_MODEL is set to ... - new sessions use that while it is set").
- `[1m]` is Claude Code's own client-side 1M-window lever: `Gc(e) = /\[1m\]/i.test(e) -> 1e6` (`keysync/keysync.mjs:830-835`). For `anthropic/*` ids the relay strips it at its last hop and Claude Code accepts it (`keysync/keysync.mjs:1801-1809`; `keysync/probe-1m-suffix.mjs:1-12`). For third-party ids Claude Code rejects `[1m]` (`unrecognized_model`), hence the strip (issue #13 notes CCR re-adds it on every CCR-initiated apply for a third-party anchor). So `anthropic/claude-sonnet-5-5[1m]` is the correct form for the 1M variant and is exactly the picker row spelling; the owner's value is right.
- Live anthropic ids include `claude-sonnet-5-5` (`state/anthropic-ids-cache.json`, ids list), so the row `anthropic/claude-sonnet-5-5[1m]` exists in a live-relay build. The static curated sets (`ANTHROPIC_FULL` `keysync/keysync.mjs:779-781`, `ANTHROPIC_PICKER_FALLBACK` `:819-821`) do NOT contain sonnet-5-5, so with the relay's live catalogue unreachable the row may be absent: the validator must treat that as a loud failure, not a silent downgrade.

### 1.4 Answer to "(1) which writes"

In a keysync live run, in order:

1. `run.mjs:1785-1796` sets `p.model` and `cfg.profile.claudeCode.model` (and five siblings) in the in-memory config.
2. `run.mjs:1867` `saveConfig` persists that to CCR's DB and, with `applyProfile`, CCR executes `applyClaudeCodeProfile` -> `env.ANTHROPIC_MODEL = env.CCR_CLAUDE_CODE_MODEL = env.CODEXL_CLAUDE_CODE_MODEL = f(profile.model)` where `f` = normalize + conditional `[1m]` append; plus the four `ANTHROPIC_DEFAULT_*` from their tiers (`service.ts:420-421`). This is the ONLY writer of the three vars.
3. `run.mjs:1927` `stripOneMSuffix` may remove `[1m]` from third-party values (never `anthropic/*`).
4. `settings.model` is never written by keysync or CCR in a run: kept or cleared by `reconcileUserModelPin` (`run.mjs:1952`). `/model` and uwpick write it.
5. `run.mjs:2003` `atomicWriteJson` writes the merged file.

CCR does not need `profile.claudeCode.model` to be a routable model beyond "non-empty and authorizable": `run.mjs:1779-1780` documents an empty value fails as "Invalid API key". Subagent / small-fast routing (#47): haiku/small-fast env come from `haikuModel||smallFastModel` (`environment.ts:63`), which this plan does not change; the #47 CCR-side forcing (`builtin-agent-claude-code` policy) was closed at its source in `spike/uw-router.cjs` (#47 final comment), so `profile.model` no longer rewrites mid-session requests. Subagents that inherit the main model will now run sonnet-5-5; subagents using the `sonnet`/`opus`/`haiku` aliases keep their tier mappings.

---------------------------------------------------------------------------------------------------

## 2. Candidate comparison

| Criterion | A: owner data file, keysync sets `profile.model` and re-asserts env | B: keysync stops managing ANTHROPIC_MODEL | C: change `ANTHROPIC_TIERS.model` constant |
|---|---|---|---|
| Owner requirement (fixed, not overridden) | Met. Fixed in CCR's DB (input) and verified in settings (output). | NOT feasible as stated: CCR clears and rewrites the 3 vars on every apply (`service.ts:420-421`) and an empty `profile.model` breaks auth (`run.mjs:1779-1780`). Would need keysync to snapshot the env and restore it after `saveConfig`, while the persisted `profile.model` stays at the old anchor, so any CCR-initiated apply (#13) reverts it. | Met only until the owner wants another model. |
| Pillar "key lifecycle must scale / no source edit" | Met (data file + CLI, `key-choices.json` precedent). | n/a | Violated: a source edit and a redeploy per change. |
| #74 finding (pin vs env) | Does not try to alter Claude Code's precedence; uses it deliberately: env is the owner's fixed default, pin is the in-session lever. | If the env were removed, pin would win and `/model` picks would persist (the opposite of "fixed"). | Same as today with a different constant. |
| Survives CCR-initiated applies (gateway restart, UI action) | Yes: persisted `profile.model` is the default. | No. | Yes, but only after the next keysync run. |
| Anchor's other job (Claude Code's own traffic needs a payload-capable model; keysync prefers verified/preferred rows) | Default must be a picker row; when no default is set today's resolution is unchanged. Only `tiers.model` is overridden; the five other tiers keep their constants / anchor. | n/a | Unchanged. |
| Failure modes | Fatal before any write on invalid/removed default; previous values kept. | Silent drift. | n/a |

RECOMMENDATION: A, with `/model` semantics stated plainly to the owner (Q1).

---------------------------------------------------------------------------------------------------

## 3. Design (candidate A)

### 3.1 Data file and loader (new module `keysync/default-model.mjs`; hot files stay untouched except `run.mjs`)

- File: `~/.llmkeys/default-model.json`, content `{"model":"anthropic/claude-sonnet-5-5[1m]"}`. Constant `DEFAULT_MODEL_FILE`, path override env `UW_DEFAULT_MODEL_FILE` (precedent `UW_ANTHROPIC_RELAY`, `keysync.mjs:977`; needed so verification can exercise the fail-loud path without touching owner data). Why `~/.llmkeys` and not `state/`: `key-choices.json` is the repo's own precedent for an owner-deliberate, keysync-consumed choice that must not be a source edit (`keysync.mjs:71-84`) and `state/` is documented per-machine runtime state (`.gitignore:34-35`) that tools rewrite freely.
- `loadDefaultModel(file)` returns `null` ONLY when the file does not exist (ENOENT). Corrupt JSON, non-object, missing/empty/non-string `model`, whitespace/control characters, `model` not matching `^[A-Za-z0-9][A-Za-z0-9._:@+\-]*/[A-Za-z0-9._:@+\-/]*(\[1m\])?$` (provider/id shape with optional trailing `[1m]`) all THROW `DefaultModelError` naming the file. It must NOT use `readJsonOr` (`menu/atomic.mjs:39-43` returns the fallback on any error, i.e. a typo would silently become "unset" -> anchor override, the exact silent failure to avoid). Tolerates a leading BOM and CRLF (hand-edit in Notepad), like `settingsRaw` at `run.mjs:1919`.
- `resolveDefaultModel(pickerRows, loaded)` -> `null` (unset) or `{model, via:"default-file"}`. The id must EXACT-match a `built.picker` row (case-sensitive, because it is written verbatim into env). Otherwise throw with: the value, the file, "not a built picker row (relay down / row pruned / typo)", up to 3 near-misses (case-insensitive and `[1m]`-insensitive), and the two remedies (`key.mjs default-model clear`, or fix the id).
- `profileTiers({anthropicOn, anchorModel, defaultModel})`: extracts the inline ternary at `run.mjs:1759-1762` into a pure function returning a NEW object (never mutate `ANTHROPIC_TIERS`): base = relay-on ? `{...ANTHROPIC_TIERS}` : six-times-anchor; then `if (defaultModel) base.model = defaultModel`. Only `model` is overridden; opus/sonnet/haiku/smallFast/fable tier mappings stay exactly as they are (owner: "should stay").
- `envFormOf(id)`: the value as it must appear in settings after `stripOneMSuffix` (anthropic/* kept; third-party loses trailing `[1m]`), so the assertion cannot disagree with the strip.
- `applyDefaultModel(settings, defaultModel)`: if `defaultModel` is null, no-op, returns 0. Else ensures `settings.env` exists and sets the three vars to `defaultModel` (pre-strip), returns the number of vars whose value changed (for the log: 0 means CCR already produced exactly this).
- `assertDefaultModel(settings, defaultModel)`: null -> no-op. Else throws if any of the three vars `!== envFormOf(defaultModel)`. Called inside the existing try so a failure restores settings from the backup (`run.mjs:2033-2058`).
- `setDefaultModel({id, file, builtRowsFile, force})`, `clearDefaultModel({file})`, `showDefaultModel({file})` back the CLI (kept in the module so tests can import them; `key.mjs` runs its switch at import and cannot be imported, `key.mjs:184-196`). `set` validates shape, then if `keysync/built-rows.json` exists refuses an id absent from it (message cites its `generatedAt`; `--force` overrides), and writes with `writeAtomic` (LF, tmp+rename). If `built-rows.json` is absent it only warns. The authoritative check is always run.mjs against `built.picker`, including in `--dry`.

### 3.2 CLI (thin wrapper in `keysync/key.mjs`)

`node keysync/key.mjs default-model show | set <id> [--force] | clear`. Subcommand form (not `--clear`) because `parseArgs` makes every `--flag` swallow the next token (`key.mjs:174-182`); put `--force` last. Update the usage line `key.mjs:194`. Wording in `--help`: "the model every new session starts on; /model picks do not persist across sessions while this is set".

### 3.3 run.mjs wiring (single writer; all small insertions, no reindent of the entry-point block)

1. Import from `./default-model.mjs` (near `run.mjs:21-27`).
2. After the picker is final (after the relay block, before the collisions/`if (dry)` block, i.e. before `run.mjs:1617`): `const def = resolveDefaultModel(built.picker, loadDefaultModel())` inside try; on `DefaultModelError` print the message to stderr and `process.exit(1)` BEFORE `--dry` returns and before any write (same placement and reason as `collisions.fatal`, `run.mjs:1611-1614`). With `--no-profile` it is a warning only, because that mode writes no profile and no settings (`run.mjs:1773`, `:1904-1907`). Print one line in all modes: `default model: <id> (source: default-model.json)` or `default model: none (profile anchor follows <via>)`.
3. `--dry` additions (prints only): the resulting profile tiers, and the expected three env values; optionally read-only current values of those three keys from `~/.claude/settings.json` for a diff. No write to settings.
4. At `run.mjs:1759`: `const tiers = profileTiers({anthropicOn, anchorModel, defaultModel: def?.model ?? null})`; `resolveAnchor` call and its log line stay (`:1751-1756`). Fix the log at `:1912` to print `tiers.model` instead of `anchorModel` (today it prints the constant even when relay is on, correct only by coincidence of `resolveAnchor`).
5. In the post-CCR merge, immediately after `settings` is parsed and BEFORE `stripOneMSuffix` (`run.mjs:1927`): `const healed = applyDefaultModel(settings, def?.model ?? null)`; log `default model held by CCR` (0) or `re-asserted N env var(s) CCR rewrote`. Order matters: strip stays the last word on third-party suffixes, and `assertDefaultModel` compares against `envFormOf`.
6. In step 5 verify (`run.mjs:2019-2026`), after `assertSettingsInvariants`: `assertDefaultModel(final, def?.model ?? null)`.
7. Reword the pin NOTE (`run.mjs:1972-1974`): when a default is set it must say "New sessions start on the owner default (<id>) from ~/.llmkeys/default-model.json, not on the pin; /model applies to the running session only. Change the default with: node keysync/key.mjs default-model set <id>". When not set, keep today's text (it is the corrected #74 text).
8. Do NOT touch `keysync/safety.mjs` (fingerprint, invariants) or `keysync/keysync.mjs` (constants). Verified unnecessary: `profile.*` is outside the fingerprint (`safety.mjs:456-460`), `env` is outside the invariants (`safety.mjs:383`).

### 3.4 Behaviour table

| State | Result |
|---|---|
| Default file absent | Exactly today's behaviour: tiers = `ANTHROPIC_TIERS` (relay on) or all-anchor (relay off); `applyDefaultModel`/`assertDefaultModel` are no-ops. |
| Default set, valid, relay on | `profile.model` = default; CCR writes the 3 vars; keysync confirms/heals; four `ANTHROPIC_DEFAULT_*` unchanged; second keysync run produces an identical env (idempotent). |
| Default set, relay down / `--no-anthropic`, default is an `anthropic/*` row | Row absent -> `DefaultModelError` -> exit 1 before any write, nothing changed, previous settings AND previous CCR `profile.model` retained. Loud, never a fallback. `--no-profile` run still works (warning). |
| Default file corrupt or malformed | Exit 1 with file path and reason; never read as "unset". |
| Default is a third-party row | Works through the existing strip; `[1m]` is dropped in env and CCR re-adds it on later CCR-initiated applies (issue #13, unchanged limitation). Not a goal of this change; document it. |
| `/model` pick in a session | Writes `settings.model`; that session uses it; next new session starts on the default (env wins, #74). `reconcileUserModelPin` keeps/clears the pin exactly as now. |

### 3.5 Windows / CRLF
- Writes to settings.json go through `atomicWriteJson` (`safety.mjs:550-585`): always LF, no BOM, ACL preserved. A CRLF/BOM settings.json is normalised to LF/no BOM on the first keysync write (pre-existing, JSON-equivalent). New code adds no raw-text edits to settings.json; it mutates the parsed object only.
- The new data file is read BOM/CRLF-tolerant and written with `writeAtomic` (LF).

---------------------------------------------------------------------------------------------------

## 4. Tests (all offline, injected fakes, repo style: `node:test`, `node:assert/strict`, temp dirs; run.mjs not executed)

### 4.1 Existing tests that pin the anchor / tiers / env (audit result)

Under candidate A none must change, because `ANTHROPIC_TIERS` and `resolveAnchor` semantics are untouched. They must all be re-run unchanged and stay green:

| File | What it pins |
|---|---|
| `test/routing-split.test.mjs:744-800`, `:1146-1190`, `:1214+` | `resolveAnchor` (relay-on returns `ANTHROPIC_TIERS.model`, preference/verified/picker-head), `reconcileUserModelPin`, and source pins on `run.mjs` text (`RUN_SRC`) |
| `test/no-restart-guard.test.mjs:1-80` | Source order of `--no-restart`, `snapshotConfigDb`, `fs.copyFileSync(SETTINGS, backup)`, `await rpc("saveConfig"`, single `const willRestart =`; profile-only change = no restart. Executor must not reword those strings. |
| `test/gateway-discovery-guard.test.mjs:1-60` | `stripGatewayDiscovery(settings)` index < `atomicWriteJson(SETTINGS, settings)`; `assertSettingsInvariants` passes with env removal |
| `test/safety.test.mjs`, `test/snapshot.test.mjs`, `test/sanitize.test.mjs` | settings invariants / write helpers |
| `test/verified-only.test.mjs:3` | imports `applyVerifiedOnly` from `run.mjs` (entry guard) |
| `test/denylist.test.mjs`, `test/catalog.test.mjs`, `test/anthropic-catalog.test.mjs`, `test/hud-shim.test.mjs`, `test/contracts.test.mjs` | mention `claude-opus-5` as fixture data only; unaffected |

No test pins the pin-NOTE text (grep for `New sessions` / `differs from the profile anchor` in `test/` is empty), so item 3.3.7 needs no existing-test change.

If candidate C were chosen instead, `test/routing-split.test.mjs:783-785` and `:1159` would be the first to fail (they compare to `ANTHROPIC_TIERS.model` by reference, so they would still pass) and a constant edit would need new pins; another reason A is smaller.

### 4.2 New file `test/default-model.test.mjs` (single file, so the test lane never touches existing files)

Fakes: a `fakeCcrApply(settings, profile, windows)` that mirrors `service.ts:411-421` + `:2218-2244` (clear the 8 managed keys; derive from `profile.*`; append `[1m]` iff window >= 1M and not already suffixed; leave every other key untouched). Its header cites those lines; the live mirror is checked once in section 5.

1. default honoured: `loadDefaultModel` (temp file) -> `resolveDefaultModel` against a fixture picker -> `profileTiers` gives `model` = default and the other five tiers deep-equal `ANTHROPIC_TIERS` minus `model` (relay-on) and all-anchor (relay-off).
2. keysync never changes it: fixture settings holding the owner's current values; run `fakeCcrApply` (profile from `profileTiers`) -> `applyDefaultModel` -> `stripOneMSuffix` -> `assertDefaultModel`; env deep-equals the input, `applyDefaultModel` returns 0; run the whole chain a second time -> byte-identical JSON (idempotent).
3. CCR takeover re-asserted: profile with the OLD anchor (`profile.model = anthropic/claude-opus-5`, i.e. what a CCR-initiated apply from a stale DB does) makes the fake write opus-5 to all three vars; `applyDefaultModel` returns 3 and the three equal the default; `assertDefaultModel` passes. Also a `[1m]`-mismatch case (CCR dropped/added the suffix) healed.
4. invalid default fails loudly: corrupt JSON, empty file, `{}`, non-string, empty string, whitespace/newline/control char in the id, id lacking `/`, id not in picker (error text contains the file path, the value, and a near-miss such as the bare/suffixed spelling), relay-down picker without `anthropic/*` rows -> all throw `DefaultModelError`; a corrupt file must NOT return `null` (guards against the `readJsonOr` trap); ENOENT returns `null`.
5. unset keeps current behaviour: `profileTiers(..., defaultModel:null)` equals today's inline ternary result for both branches (compare against a copy of the old expression written in the test), `ANTHROPIC_TIERS` deep-equals a pre-captured snapshot afterwards (never mutated), `applyDefaultModel`/`assertDefaultModel` no-ops.
6. effort settings untouched: settings with `effortLevel:"high"`, `modelSettings` keyed by `claude-sonnet-5-5` and `anthropic/claude-sonnet-5-5[1m]`, `model` pin, `ANTHROPIC_DEFAULT_*` tier env, `ANTHROPIC_BASE_URL`, hooks/permissions: after the chain only the three vars may differ; `assertSettingsInvariants(before, after)` does not throw.
7. env injection / third party: `envFormOf` for `anthropic/x[1m]` keeps the suffix, for `acme/x[1m]` drops it and equals what `stripOneMSuffix` produces on the same value; a value containing `"`, newline or `,` is rejected at load.
8. `assertDefaultModel` throws when any of the three vars is missing or different, naming the variable.
9. fingerprint: `restartRelevantFingerprint` unchanged when only `profile.claudeCode.model` / `profile.profiles[].model` changes (extends the no-restart pin without editing `no-restart-guard.test.mjs`).
10. CLI logic: `setDefaultModel` writes parseable LF JSON, no leftover `.tmp-*`; refuses an id missing from a fixture `built-rows.json` unless `force`; warns-only when `built-rows.json` is absent; `clearDefaultModel` removes the file; BOM+CRLF hand-edited file loads.
11. wiring by source order (repo style, comments stripped like `no-restart-guard.test.mjs:15-24`): `resolveDefaultModel(` appears before `if (dry) {`; `profileTiers(` before `const p = cfg.profile?.profiles?.find`; `applyDefaultModel(settings` before `stripOneMSuffix(settings)`; `assertDefaultModel(final` after `assertSettingsInvariants(settingsBefore, final)` and before `console.log("keysync complete")`; `ANTHROPIC_TIERS` never appears as an assignment target in `run.mjs` or the new module.

---------------------------------------------------------------------------------------------------

## 5. Verification plan (no live state touched before approval)

### 5.1 Pre-approval (allowed now / by executor + verifier; nothing here writes settings.json, CCR, or the gateway)

```
node --test test/default-model.test.mjs
node --test test/                      # full suite, must equal pre-change green count
node keysync/run.mjs --dry             # writes only keysync/built-rows.json (gitignored)
```
`--dry` assertions (exit 0):
- stdout contains `default model: anthropic/claude-sonnet-5-5[1m] (source: default-model.json)` once the file exists (the owner or main creates it with `node keysync/key.mjs default-model set ...`; that touches only `~/.llmkeys`).
- stdout shows the expected env triple equal to that id and the four tier mappings unchanged (opus `anthropic/claude-opus-5[1m]`-style values as today).
- negative, no owner data touched: `UW_DEFAULT_MODEL_FILE=<temp file with {"model":"anthropic/claude-sonnet-9-9[1m]"}> node keysync/run.mjs --dry` -> exit 1, error names the file and value, nothing written; same with a corrupt temp file; same with `--no-anthropic` (anthropic row absent) -> exit 1.
- unset: `UW_DEFAULT_MODEL_FILE=<path that does not exist> node keysync/run.mjs --dry` -> `default model: none` and output otherwise identical to pre-change `--dry` (diff the two outputs).
Do not run `--target isolated` unless the isolation proof is re-verified first (memory: CCR takeover and sandbox-port gotchas); the pure-function `fakeCcrApply` tests replace it.

### 5.2 Live apply (requires owner approval; announce before the gateway restarts)

Pre-state capture (read-only): hash/print the 3 env vars, `model`, `effortLevel`, presence of `modelSettings` keys; the owner's backup `settings.json.bak-default-sonnet55-*` already exists.

```
node keysync/key.mjs default-model set "anthropic/claude-sonnet-5-5[1m]"
node keysync/run.mjs --dry
node keysync/run.mjs --target live --i-know --no-restart
```
- `--no-restart` first: a default-only change predicts no restart (`safety.mjs:456-460`); if Providers changed since the last apply it refuses with exit 2 and writes nothing (`run.mjs:1821-1826`). Only then announce to the owner ("this restarts the gateway; other Claude Code sessions' in-flight requests may be interrupted, run.mjs:1858-1864") and re-run without `--no-restart`.
- Restore points: `~/.claude/settings.json.uw-backup-<stamp>` (`run.mjs:1830`), `%LOCALAPPDATA%\uw-keysync\backups\` config.sqlite snapshot (`safety.mjs:13`, restore hint `:76`, newest 5 kept `:190`). A failed run auto-restores settings (`run.mjs:2033-2058`).
- Post-apply checks (read-only):
  - `node -e` printing `ANTHROPIC_MODEL`, `CCR_CLAUDE_CODE_MODEL`, `CODEXL_CLAUDE_CODE_MODEL` (all equal `anthropic/claude-sonnet-5-5[1m]`), the four `ANTHROPIC_DEFAULT_*` (unchanged: opus `anthropic/claude-opus-5[1m]`, sonnet `anthropic/claude-sonnet-5[1m]`, haiku `anthropic/claude-haiku-4-5-20251001`, fable `anthropic/claude-fable-5-1`), `model`, `effortLevel`, and `Object.keys(modelSettings)` (never values of any apiKey/token field).
  - Run `node keysync/run.mjs --target live --i-know --no-restart` a second time: expect "config identical", env triple unchanged (idempotence on the real stack).
  - Cross-check `fakeCcrApply` against reality once: compare the pre/post env diff to what the fake predicts for the same inputs; any mismatch means the research-copy assumption (`service.ts`) drifted from the live 3.0.22 dist and tests must be adjusted before merge.
  - Fresh Claude Code session: `/status` model line shows `anthropic/claude-sonnet-5-5[1m]` (or "Sonnet 5.5") and 1M context; then `/model` to another model, quit, start a new session: `/status` shows sonnet-5-5 again (documents Q1 behaviour).
- Rollback: `node keysync/key.mjs default-model clear` then repeat the apply (returns to today's anchor behaviour); or restore `settings.json` from the `uw-backup-<stamp>` and the config.sqlite snapshot via `restoreConfigDbHint`; code rollback `git revert` of the branch. The owner's own hand backup remains.

---------------------------------------------------------------------------------------------------

## 6. Docs and records

- `docs/runbook.md` section 5 (`:93-133`, key lifecycle): add the `default-model show|set|clear` commands, the file location, the "fatal on invalid" rule, and the `/model` semantics; troubleshooting entry near `:1202-1218` ("new session starts on the wrong model / pin ignored" -> env wins, how to change the default).
- `docs/qa-interactive-protocol.md`: add one post-apply step ("new session `/status` shows the default; `/model` pick does not persist") only if that file has a post-apply checklist; currently it has no anchor/ANTHROPIC_MODEL text, so skip otherwise.
- Issue #74 closing comment (draft): "Resolved by design on `feat/default-model-fixed`: `env.ANTHROPIC_MODEL` (with `CCR_CLAUDE_CODE_MODEL`, `CODEXL_CLAUDE_CODE_MODEL`) is now the owner-set default in `~/.llmkeys/default-model.json`, written into CCR's profile and re-asserted after CCR's takeover; keysync no longer silently decides it. The client-side precedence (env over `settings.model` for new sessions) is Claude Code's and is unchanged; `/model` remains an in-session lever. Of the three shapes in the 2026-09-07 deferral: (1) is infeasible because CCR writes the variable from `profile.model` (service.ts:420-421) and an empty profile model breaks auth; (3) contradicts a fixed default; this is a fourth shape." Close only after the live apply is verified.
- Cross-reference #13 (third-party anchor `[1m]` re-added by CCR) as a known limit; #47 closed-loop note.
- Memory (owner decides): one line under the pillar rules, "Default model is owner data, not a constant" (extends "Key lifecycle must scale"), and a note that the hand-edited settings.json env was not durable until this lands.

---------------------------------------------------------------------------------------------------

## 7. Execution plan: roles, order, serialization

Stages (authoring never approves itself):

| # | Role | Lane (files) | Output / gate |
|---|---|---|---|
| 0 | critic (separate from planner) | read-only | Challenges this plan; owner answers Q1-Q4 |
| 1 | test-engineer | writes ONLY `test/default-model.test.mjs` | Red tests against the signatures in 3.1 (interface is frozen by this plan) |
| 2 | executor (opus for run.mjs) | writes `keysync/default-model.mjs` (new), `keysync/key.mjs`, `keysync/run.mjs`; no other file | Green `node --test test/` |
| 3 | code-reviewer (fresh context) | read-only | Diff review incl. unchanged-behaviour proof for unset default |
| 3 | security-reviewer (parallel with code-reviewer, read-only) | read-only | Env injection via the id (charset allow-list), `UW_DEFAULT_MODEL_FILE` path handling, no secret printed in `--dry` settings read, `writeAtomic` temp debris, ACL on the new file |
| 4 | verifier | read-only + runs 5.1 commands | Evidence: test counts, `--dry` outputs (positive and the 3 negative cases) |
| 5 | owner approval | - | Go/no-go for live apply |
| 6 | main/owner runs 5.2; verifier re-checks read-only | live | Post-apply checks green; then docs + #74 comment |

Serialization: `keysync/run.mjs` is a shared hot file with exactly one writer (the executor) for the whole branch; `keysync/keysync.mjs` and `keysync/safety.mjs` are deliberately NOT edited, so no other lane contends for them. Stages 1 and 2 touch disjoint files and may run in parallel once 3.1 signatures are accepted; stage 2 must not start editing `run.mjs` while any other active agent in this session (exec-l0-status-columns*, exec-probe-all, review-*, etc.) holds it: the main thread should confirm with them and work on branch `feat/default-model-fixed`. Never run keysync live from an agent without the owner's go (memory: R19 still gates the apply; announce restarts).

### Acceptance criteria (runnable)
1. `node --test test/default-model.test.mjs` all pass; `node --test test/` pass count >= pre-change count, zero skipped/only/stub tests (`grep -n "\.skip\|\.only\|todo" test/default-model.test.mjs` empty).
2. `git diff --stat master` touches only: `keysync/default-model.mjs` (new), `keysync/key.mjs`, `keysync/run.mjs`, `test/default-model.test.mjs` (new), `docs/runbook.md`. `git diff master -- keysync/keysync.mjs keysync/safety.mjs` is empty.
3. `node keysync/run.mjs --dry` exit 0 and prints the `default model:` line; the three negative `UW_DEFAULT_MODEL_FILE` cases exit 1 with nothing written (check `~/.claude/settings.json` mtime unchanged).
4. Unset-default `--dry` output diff vs pre-change output is empty apart from the new `default model: none` line.
5. After live apply: the post-apply checks in 5.2 all hold, second apply is "config identical" with an unchanged env triple.

---------------------------------------------------------------------------------------------------

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Research-copy `service.ts` differs from live dist | Version matches (3.0.22); one-time pre/post diff in 5.2 confirms; fake is cited line-for-line |
| Relay outage blocks all keysync profile runs (default row absent) | Intended loud failure; `--no-profile` still works; documented remedy `default-model clear`; Q3 |
| Owner sets a model whose row later disappears (provider pruned) | Same fatal-before-write path; message names the value, the file, near-misses |
| `[1m]` spelling drift (row loses the suffix if live context drops <1M) | Exact match + near-miss hint; failure is loud, not a silent 200k window |
| Hand-edited settings.json reverted by a CCR-initiated apply before this lands | Known (inferred from `service.ts:420-421`, not measured); land and apply soon, or re-apply the hand edit |
| New code mutates shared `ANTHROPIC_TIERS` | `profileTiers` returns a copy; test 5 snapshots the constant; wiring test forbids assignment |

---------------------------------------------------------------------------------------------------

## 9. Open questions for the owner (max 4)

1. `/model` persistence: with the env fixed, a `/model` pick (including uwpick) works for the running session but the NEXT session always starts on sonnet-5-5. Is that what you mean by "fixed"? (Recommended: yes. The alternative, removing the env so the pin wins, makes picks persist but cannot be done safely: CCR rewrites the env from `profile.model`, and an empty one breaks auth.)
2. Is the 1M variant `anthropic/claude-sonnet-5-5[1m]` the intended default (it is the exact picker-row spelling and what you hand-edited), as opposed to the 200k bare `anthropic/claude-sonnet-5-5`?
3. When the relay is down (so the default row is absent), keysync should REFUSE a profile-writing run with exit 1 and no writes (recommended, never silently fall back to opus-5 or another anchor). Acceptable, given `--no-profile` still works for gateway-only runs?
4. Should keysync also force `settings.model` (the pin) to equal the default on each apply so settings.json is self-consistent and Claude Code stops printing the "new sessions use ANTHROPIC_MODEL" notice? Recommended: no, the pin stays owner/uwpick-owned (`reconcileUserModelPin` unchanged).

---------------------------------------------------------------------------------------------------

## 10. Implementation record (executor, 2026-10-01; NOT committed, NOT applied live)

Owner decisions: Q1 yes (fixed default every new session; /model pick = running session only); default `anthropic/claude-sonnet-5-5[1m]`; Q3 refuse loudly (exit 1, nothing written) when the row is absent, `--no-profile` still works (warning only); Q4 keysync does NOT force `settings.model`.

Done: [x] `keysync/default-model.mjs` (new) [x] `keysync/key.mjs default-model show|set|clear` [x] `keysync/run.mjs` wiring (insertions before `if (dry) {`, tiers via `withDefaultModel`, no-default WARNING before saveConfig, post-saveConfig persisted-profile assertion, re-assert before strip, final assertion, log lines) [x] `test/default-model.test.mjs` (36 tests) [x] `docs/runbook.md` section 5a. Not edited: `keysync/keysync.mjs`, `keysync/safety.mjs`, any existing test.

Deviations from sections 3-4 above (critic corrections, owner brief):
- 3.1: no `~/.llmkeys/default-model.json` shape regex; deny-list (`validateShape`) instead. `set` never consults `keysync/built-rows.json` (pre-relay object snapshot, no anthropic rows); advisory warning against `state/anthropic-ids-cache.json` only; the authoritative row check is run.mjs against post-relay `built.picker`.
- 3.1: `profileTiers` became `withDefaultModel(tiers, def)` wrapping the existing ternary (no extraction of the ternary text).
- 3.3.3: `--dry` prints expected values only and never reads settings.json.
- New: persisted `profile.profiles[]` and `profile.claudeCode.model` asserted equal to the default after `saveConfig` (inside the restore-on-failure try); WARNING when no default is set and the run would change a hand-set `env.ANTHROPIC_MODEL`.
- 3.3.7: the pin NOTE is a new branch used only when a default is set; the old text is unchanged.
- `--dry` exited with a libuv assertion (`UV_HANDLE_CLOSING`, exit 127 under Git Bash) AFTER its normal output and `process.exit(0)`; the code path is untouched by this change (see report), cause not isolated.

Only a live apply can verify: that `saveConfig` returns `profile.profiles[]`/`profile.claudeCode` carrying the persisted model unnormalised (the new assertion would fail loudly and restore settings if CCR normalises it); `fakeCcrApply` vs the live CCR 3.0.22 dist; second-apply idempotence on the real stack; no gateway restart for a default-only change; new-session `/status` showing the default.

### 10.1 Review fixes (round 2, 2026-10-01; NOT committed, NOT applied live)

Code review SHIP (4 minors) and security review SAFE TO APPLY LIVE (3 medium, 7 low) addressed in `keysync/default-model.mjs`, `keysync/key.mjs`, `keysync/run.mjs` (insertions only), `test/default-model.test.mjs` (now 57 tests), runbook 5a.

- M1a: `resolveDefaultModelFile({target, args})`; a live run ignores `UW_DEFAULT_MODEL_FILE` unless `--default-model-file <path>` (loud IGNORED line). M1b: `none (<path> absent; ...)`. M1c: `state/default-model.applied.json` written after the verified live apply (outside the rollback try, own warning on failure); file absent + marker present refuses before any write (also on `--dry`, not on `--no-profile`); `clear` removes both. A non-default file's marker sits beside it (`<file>.applied.json`) so tests never touch the real one.
- M2: `postCommitNotice` printed first in the catch when a default was set.
- M3: `validateShape` runs `admitId` on the id and both parts, caps 128 code points, refuses unpaired surrogates (admitId admits them, KNOWN LIMIT in menu/sanitize.mjs); all real row shapes pass admitId.
- L1 `formatShow` sanitises setAt/note; L2 4 KB cap + regular-file check; L3 set/clear fs failures and directories are `DefaultModelError`; L6 hint is JSON-quoted and sanitised; L7 shape-checked-only advisory for non-anthropic ids.
- Code MINOR 1: `default model: not applied (see warning above)` for `--no-profile` + failed resolve; MINOR 2 re-indent; MINOR 3 tests anchor on the real `--dry: nothing written.` line; MINOR 4 pin note compares `envFormOf` forms when a default is set.

Only a live apply can verify: the marker write on the real `state/` path; the IGNORED line on a real live invocation; the post-commit notice text (needs a real post-saveConfig failure); that `clear` + a live run returns to the anchor with no refusal.

# Research: CC/CCR upgrade resilience and the coupling register (2026-09-02)

Three findings reframe the question.

**1. Claude Code auto-updates itself.** `claude doctor`:
```
Running: native (2.1.258)
Commit: b3cd543a1f6f
Auto-updates: enabled
Auto-update channel: latest
Last update attempt: success → 2.1.258 (2026-09-01)
```
CC changing underneath UW is **not a risk to mitigate — it is a scheduled event** that will
happen without user action, possibly between two UW runs. `Commit: b3cd543a1f6f` is a cheap,
exact identity for the shipped binary — better than sha256 of 218 MB and finer-grained than
the version string. Fingerprint on it.

CCR is the opposite: a global npm package with no self-update, changing only on
`npm i -g` — precisely the event that silently reverted a patched file before. Its version is
available cleanly over RPC: `getAppInfo` returns `version` alongside `configDir`, `dataDir`,
`configDbFile` (function `cct()`). That is a contract, not a guess.

**2. CCR's `dist/main/cli.js` is already locally patched.** Normalizing line endings, both
files are exactly 2,299,525 bytes and diverge at one point:
```
OLD: var PN="gateway",K7=5e3,z7=15e3,aVe=4e3,J7=448,X7=384,DN=new WeakMap
NEW: var PN="gateway",K7=2e4,z7=15e3,aVe=4e3,J7=448,X7=384,DN=new WeakMap
```
`K7` is consumed once: `` `Core gateway did not accept runtime config within ${K7}ms.` ``.
All 28 `process.env.CCR_*` vars were searched — **none** governs it. The patch is
unavoidable, so it must be loudly guarded rather than eliminated.

Two traps: the raw file is **2,308,421 bytes (CRLF)** against the 2,299,525-byte LF backup,
so **any digest or size check must normalize newlines first**. And `K7` is a minified name —
after a rebuild it may be `Q3` or `zP`, so anchor the check on the stable literal
`var PN="gateway",`, not the identifier. Failure mode if lost: the 5-second handshake
reappears and fails **intermittently, only under load** — the worst class, because it reads
as flakiness rather than a broken invariant.

**3. The worst coupling is not the one previously flagged.** `behavesAs`-as-context-window is
more dangerous than the silent-picker case: the silent-picker case fails *visibly* (the
built-in lineup renders), while a wrong context window silently mis-sets auto-compact and
truncates conversations with **no error at all**.

## CC names better contracts than the ones UW uses

The unknown-model warning, verbatim from a live run:

> `"uw-nonexistent-model-xyz" isn't described by this version's model catalog; update Claude
> Code, or map it with behavesAs on a modelPicker row (or modelOverrides, if it is a provider
> id of a model this version knows). Until then auto-compact keeps this session within 200k
> tokens (the context window it assumes); if the model accepts more, append [1m] to the model
> name for 1M, or set CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window;
> CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 restores the previous
> wait-for-the-API behavior.`

Three mechanisms named in user-facing text — all confirmed present in the binary. **Text a
vendor puts in a user-facing error is the closest thing to a documented contract you get from
a closed binary.** `behavesAs`'s context-window side effect is nowhere in that text; it is an
inference from `Ve`. **Prefer the named ones.**

Also: `["modelPicker","replaceBuiltInOptions"]` appears in CC's restrictive-merge policy list
(alongside `["permissions","defaultMode"]`), so managed/enterprise settings can override it.

## A newly found silent-degradation archetype

CC carries a zod-based settings validator emitting diagnostics shaped
`{file, severity, docLink, statusOnly, startupFatal, preserveOnWrite, mcpErrorMetadata, path,
message, expected, suggestion, invalidValue}`. There are **three distinct `modelPicker`
validators with three different ignore scopes**:

1. `modelPicker` not `{options: []}` → *"…This field was ignored."*
2. `replaceBuiltInOptions` not boolean → *"…This entry was ignored (the rows are added to the built-in lineup)."*
3. a bad row under `.options.<i>` → *"…This row was ignored; the other rows still apply."*

All three are `severity: "warning"`, and they **do not surface** — proven empirically:
```
claude --settings '{"modelPicker":{"options":"not-an-array"}}' --model uw-nonexistent-model-xyz -p "x"
```
produced the unknown-model warning and **nothing** about the malformed picker.

So case 2 is a second archetype: **a non-boolean `replaceBuiltInOptions` silently becomes
`false`**, and the picker quietly reverts to "curated rows appended to built-ins" — a more
confusing wrong state than "picker ignored entirely", because it looks like it partly worked.

`claude doctor` carries an `Invalid settings` status notice, making doctor the natural oracle
— but doctor rejects `--settings`, so a probe must go through `CLAUDE_CONFIG_DIR` and a
scratch settings file.

## Root cause

UW's fragility is not "it depends on undocumented internals" — that is unavoidable and often
fine. It is that **UW encodes third-party behaviour as constants in its own source rather
than as facts it re-derives from the environment it is running in.** `safety.mjs:248-291`
mirrors a predicate; `keysync.mjs:73` mirrors a path; the design mirrors a
restart-vs-no-restart assumption. Each mirror was correct when written and has **no mechanism
to notice when it stops being correct**. The one time a mirror drifted it produced a
deterministic false "identical" — silent, and wrong in the unsafe direction.

The fix is not to remove the couplings, but to convert each from *an assertion in a comment*
into *a measurement with a cached result and an invalidation key*.

---

## Coupling register

Class: **(a)** documented/stable · **(b)** undocumented-but-structural · **(c)** implementation detail / minified — will break.

### P0 — silent wrong behaviour. Fix now.

| # | Dependency | Class | Failure mode | Mitigation | Verdict |
|---|---|---|---|---|---|
| 1 | **`behavesAs` governs context window; unmapped → 200000** (`keysync.mjs:119,234`) | (b)/(c) | **Silent wrong.** Auto-compact fires at the wrong threshold; conversations truncate with no error. Worse than the picker case — nothing renders differently. | Stop using `behavesAs` for the window. Emit `modelOverrides` where the id maps to a known model, else set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from real catalogue data. All three names come from CC's own error text. | **Rip out** |
| 2 | **`contextTokens` computed then stripped** (`run.mjs:464`) | — | Silent. UW *has* the right window and discards it, guaranteeing #1 bites. | Stop stripping; route into `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. One line, largest correctness win on the list. | **Rip out** |
| 3 | **Restart-predicate mirror** (`safety.mjs:248-291`, from minified `_E`) | **(c)** | **Silent wrong, both directions.** Router added → every selection restarts the gateway, presents as flakiness. Field removed → spurious restarts. **Has drifted once already.** | Replace the comment with probes **P1 + negative control P2**. Keep the mirror as an optimisation; treat the probe as truth. | **Keep, subordinate to probe** |
| 4 | **`resolve()` stages 3-5, bare-name cross-provider binding** | **(c)** | **Silent wrong + security.** Wrong provider serves the request — the hijack primitive. | Never emit a bare name. Depend on stage 2 only. Reserved-name denylist at ingest before any remote list is admitted. | **Rip out the dependency** |
| 5 | **Non-boolean `replaceBuiltInOptions` → silently `false`** (newly found) | (b) | **Silent wrong.** Rows append instead of replacing; looks like partial success. | Probe P5 asserts row-count bounds; validate type before writing. | **Guard** |
| 6 | **All rows fail eligibility ⇒ whole picker ignored** | (b) | **Silent wrong** (the archetype). | Probe P3/P4 + post-write assertion that at least one written row is honoured. | **Guard** |
| 7 | **`resolveProtocol` substring match** (`keysync.mjs:102-111`) | — | **Silent wrong.** `https://evil.example/anthropic/` resolves as Anthropic. Latent, wrong by construction. | Parse URL, enforce https, match hostname, pin an allowlist in code. | **Rip out** |
| 8 | **Presence-only post-write verification** (`run.mjs:471-473`) | — | **Silent.** Checks 3 keys of 20; a lost `permissions` or flipped `skipDangerousModePermissionPrompt` passes. | Conservation check against a pre-write snapshot. | **Rip out** |
| 9 | **Non-total sort → gratuitous restart** (`keysync.mjs:196-199`) | — | Silent. Upstream reordering restarts the gateway for zero semantic change. Compounded by `inferTier` returning `"unknown"` for all 4,298. | Add `\|\| a.m.model.localeCompare(b.m.model)`. **Do not fix `inferTier` in the same change** — fixing it arms the hijack. Denylist first, then tier. | **Fix, in that order** |

### P1 — loud break. Acceptable, needs an owner.

| # | Dependency | Class | Failure mode | Mitigation |
|---|---|---|---|---|
| 10 | **`K7=2e4` patch to cli.js** | **(c)** max severity | **Intermittent** — reverts on `npm i -g`; 5 s handshake fails only under load | Newline-normalized digest each run, anchored on `var PN="gateway",`. Store the patch as a re-appliable recipe + reapply step. Refuse privileged writes if absent |
| 11 | **`CATALOG_FILE` hardcoded into node_modules** (`keysync.mjs:73`) | **(c)** | Loud (ENOENT) on removal; **silent-wrong** on content change | See migration below |
| 12 | **`EXPECTED_PROVIDERS = 44` equality** (`run.mjs:32`) | — | Loud but *wrong*: a revoked key presents as a keysync failure | Floor + explicit delta acknowledgement |
| 13 | **Hardcoded absolute paths** (`verify-cli.mjs:29`, `phase5-*.mjs:16,18`, `run.mjs:33`) | (b)/(c) | Loud | Resolve via PATH then known location; one `paths.mjs`. Low priority |
| 14 | **RPC `{method,args}` + method names** | **(b)** | Loud (unknown method). Method names are **wire strings, not minified** — verified `getAppInfo:()=>cct(),getConfig:()=>bt(),…` | Probe P8 calls each at startup. **The most solid CCR dependency you have** |
| 15 | **`models.json` schema** | **(a)** — self-versions with `schemaVersion: 2` | Loud if asserted; silent if not | Assert `schemaVersion === 2`; refuse otherwise |

### P2 — cosmetic or benign

| # | Dependency | Note |
|---|---|---|
| 16 | 10-row viewport, 60% label truncation | Cosmetic. Never build logic on it. Do assert descriptions stay short — they wrap and blow the 2-line budget |
| 17 | 87 curated → 89 rendered | Only breaks if you assert an exact count. Assert `curated + 1 ≤ rendered ≤ curated + 2` |
| 18 | Search hard-disabled via `canEnter:!1` | If it changes, it *improves*. It filters on `label + description` — put searchable words in both now, at zero cost |
| 19 | `apiKeyHelper` / `env.ANTHROPIC_BASE_URL` / `model` keys | Documented keys. The **value** of `apiKeyHelper` is (c) — a CCR-regenerated path holding a rotating `ccr-profile-<random>` secret. Read it, never construct it |
| 20 | `autoFetchModels` 600 s timer | Correctly disabled. Promote to a hard `validate()` invariant, reason recorded as "it hands the restart trigger to a timer we don't control" |
| 21 | `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | **Currently set in live settings *and* `replaceBuiltInOptions: true`, which erases discovered rows. A pure-cost no-op today.** Pick one mechanism |
| 22 | Hex ids `anthropic/claude-ccrN-h<hex>` | Silent — ids collapse into one bogus group. Only matters if UW consumes gateway `/v1/models`; it should not |

---

## The capability-probe layer

```
~/.uw/capabilities.json
{
  fingerprint: {
    ccVersion: "2.1.258", ccCommit: "b3cd543a1f6f", ccSha256: "…",   // sha at setup only
    ccrVersion: "3.0.22", ccrCliSha256Norm: "…", ccrPatchPresent: true,
    catalogPath: "~/.uw/catalog/models.json", catalogSchema: 2,
    catalogGeneratedAt: "2026-08-24T12:22:28.162Z"
  },
  probes: { P1: {pass:true, at:"…", evidence:"…"}, … }
}
```

Recompute the **cheap** part every run (`claude doctor` parse + RPC `getAppInfo` + `stat` —
all sub-second). Recompute digests only when the cheap part moves.

| Probe | Asserts | How |
|---|---|---|
| **P1** router-rules-do-not-restart | The load-bearing unlock | Record gateway pid → `saveConfig` changing only `Router.rules[].target` → poll pid + `/health` → assert pid unchanged |
| **P2** providers-change-DOES-restart | **Negative control** | Same but change `Providers[]` → assert pid **does** change. Without this, P1 passing is indistinguishable from "saveConfig never restarts anything" (e.g. a wedged daemon). **A probe with no negative control is not a probe.** |
| **P3** picker-schema-accepted | modelPicker shape parses | Scratch `CLAUDE_CONFIG_DIR` + known-good 3-row picker → `claude doctor` → no `Invalid settings` notice |
| **P4** picker-malformed-is-detected | Calibrates UW's detector, not CC | Same with a malformed picker → assert doctor **does** report it |
| **P5** replaceBuiltInOptions-honoured | Rows replace, not append | Known-good N-row picker → rendered count ∈ [N+1, N+2] and a known built-in id **absent** |
| **P6** context-window-mechanism | Which of `behavesAs` / `MAX_CONTEXT_TOKENS` / `modelOverrides` actually sets it | Run each; assert on the "keeps this session within 200k tokens" warning |
| **P7** catalog-contract | `schemaVersion === 2`, required paths present | Pure read |
| **P8** rpc-methods-present | Every RPC method UW calls exists | Benign call each |
| **P9** ccr-patch-present | The 20 s handshake survives | Regex `var PN="gateway",[A-Za-z_$0-9]{1,6}=2e4` on newline-normalized content |
| **P10** selector-resolution | Stage 2 works; stage 4 ambiguity is a hard stop | `provider/model` binds; a shared bare name resolves to nothing |
| **P11** catalog-path-honoured | CCR reads UW's copy | Set `CCR_MODEL_CATALOG_PATH`, restart, assert `loadedFrom` |

### Policy on an unrecognised version — be asymmetric

- **Reads and `--dry` always proceed**, even Red. Refusing to *diagnose* when the environment just changed is exactly backwards.
- **Privileged writes refuse** on Red. Not warn — a warning on a tool that rewrites a settings file a live session depends on becomes background noise within a week, and a session has already been lost to a silent replacement.
- **Amber** (fingerprint moved, probes re-ran and passed) proceeds and logs the delta. **This is the common path, because CC auto-updates.**
- The refusal must name **the failing probe and its evidence**: *"P1 failed: gateway pid changed from 41208 to 41904 after a Router-only save — Router now triggers a restart"* is actionable; "unrecognised CCR version" is not.

**Caveat to keep explicit:** P1 is only as good as its last run. It proves the predicate held
*at probe time*. So keep the `safety.mjs` mirror as a **runtime pre-flight**: before each
apply, fingerprint what you are about to send, and if it differs on any predicate field,
expect a restart and say so. **Probe for the design assumption; mirror for the individual
write.** Complementary, not redundant.

---

## The `models.json` migration — do both, in order

1. **Now, zero-risk:** copy `dist/models.json` to `~/.uw/catalog/ccr-models-<generatedAt>.json` plus a `models.json`; repoint `keysync.mjs:73`. Removes the node_modules dependency in one line, no new network surface.
2. **Same change:** set **`CCR_MODEL_CATALOG_PATH`** to that file in CCR's launch environment. It is **first** in CCR's search order (`JMe()`: `CCR_MODEL_CATALOG_PATH` → `CCR_MODELS_JSON_PATH` → `cwd/models.json` → `cwd/packages/core/models.json` → … → `__dirname/../models.json`), and `db()` returns `{loadedFrom, payload}` so it is **observable** (probe P11). Now UW and CCR read one artifact UW owns — which also closes the hazard that **`resolve(process.cwd(), "models.json")` sits above the node_modules copy**, so CCR started from a directory containing a stray `models.json` silently loads it.
3. **Then, for freshness:** make **models.dev** authoritative for pricing/context/modality — 7,502 vs 4,298 models, hourly sync, MIT, ETag + must-revalidate so refresh is a conditional GET, mirrored as `@opencode-ai/models` if a pinned npm artifact is preferred. Zero API keys. Keep the CCR copy as fallback **and cross-check** — disagreement is itself a signal worth logging.
4. **Detecting a newer CCR catalogue:** compare `{schemaVersion, generatedAt, sha256}`, not content. If `schemaVersion !== 2`, refuse to parse and fall back — a schema bump is exactly when silent misparse happens.

Do **not** re-derive from litellm/OpenRouter directly; models.dev already consumes all three
and normalises them.

---

## The upgrade self-check

**Tier 1 — every UW invocation, < 2 s, no API calls, no writes:**
```
1. claude doctor      → version, Commit, Auto-updates, "Invalid settings"
2. RPC getAppInfo     → version, configDir, dataDir  (also proves the daemon is ours)
3. stat + schemaVersion on the UW catalogue copy
4. P9 regex on newline-normalized cli.js → patch present
5. compare against capabilities.json
   equal   ⇒ Green, proceed
   differs ⇒ Amber, run Tier 2 before any privileged write
```

**Tier 2 — on fingerprint change or `uw selfcheck --full`, in the harness (separate ports and config dir):**
```
P1 + P2  router-restart pair            ~15 s   ← the one that matters
P3 + P4  picker schema accepted/rejected ~20 s
P5       replaceBuiltInOptions bounds    ~10 s
P6       context-window mechanism        ~30 s
P7       catalog contract                 <1 s
P8       RPC methods present              ~2 s
P10      selector resolution             ~10 s
P11      CCR reads UW's catalogue        ~10 s
```
Under two minutes, no billed inference except P6 (which can use the free relay).

**`--bare` is worth evaluating for spawn-based probes:** per `claude --help` it *"skip[s]
hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and
CLAUDE.md auto-discovery"* and forces auth to `ANTHROPIC_API_KEY` or `apiKeyHelper` via
`--settings`. Materially more deterministic than what `verify-cli.mjs` spawns today, and it
removes several env-leak hazards that file documents at lines 59-65.

Keep `verify-cli.mjs` as the **row-level** gate — right for what it does, wrong instrument
for upgrade detection (87 sequential spawns is too slow per invocation). **Tier 1/2 detect
environment change; `verify-cli.mjs` detects row death.**

---

## What UW should deliberately NOT depend on

1. **`resolve()` stages 3, 4, 5.** Only stage 2 (`provider/model`). Bare-name resolution is the hijack primitive; depending on it turns a *correctness* fix (`inferTier`) into a *security regression*.
2. **Anything about rendered layout** — 10 rows, 60% truncation, wrap behaviour, disabled-row reordering.
3. **`behavesAs` as a context-window mechanism.** Use the mechanisms CC names in its own error text.
4. **`inferTier` as a free/paid signal.** Already 0/4,298 — and fixing it arms the hijack, so the denylist lands first.
5. **The CCR gateway as a fetch proxy for model lists.** `request_logs.url` is unredacted and Google's endpoint carries the key in the query string. Use `probeProvider` or fetch directly with `redirect: "manual"`.
6. **`autoFetchModels`, ever.** Union-only merge, sequential, no per-provider timeout, hands the restart trigger to a 600 s timer.
7. **The `apiKeyHelper` path or token value.** Both CCR-regenerated; the token rotates.
8. **CC's search staying disabled.** Design as if `canEnter` flips to true.
9. **CCR's catalogue-path precedence.** Set `CCR_MODEL_CATALOG_PATH` explicitly.
10. **Gateway `/v1/models` as a catalogue.** Flat, no pricing, profile-filtered, hex-mangled ids. `getConfig` + catalogue join is strictly better.

## Notable trade-off flagged

**`CLAUDE_CODE_MAX_CONTEXT_TOKENS` is process-wide**, so a per-row window needs per-row env,
which the settings `env` block cannot express dynamically. **This is a real limitation** —
`modelOverrides` may be the only per-row route, and **probe P6 should settle which mechanism
actually wins before committing.**

## Key references

- `keysync.mjs:73` — CATALOG_FILE in node_modules · `:87-94` inferTier (0/4298) · `:102-111` resolveProtocol substring · `:196-199` non-total sort · `:234` `row.behavesAs = BEHAVES_AS`
- `run.mjs:32` EXPECTED_PROVIDERS equality · `:463-465` picker write · `:464` contextTokens stripped · `:471-473` presence-only verification
- `safety.mjs:248-291` — the mirror, documenting its own prior drift
- `harness/guard.mjs:267-271` — `assertRouterClean` forbids all enabled Router rules; **must be scoped, not deleted**
- `verify-cli.mjs:29` hardcoded path · `:59-65` the env-leak class `--bare` would close
- CCR `cli.js` @ byte ≈1,607,700 — `var PN="gateway",K7=2e4,…`; backup `cli.js.bak-timeout-fix`, identical after CRLF normalization
- CCR `cli.js` `cct()` — getAppInfo · `JMe()` — catalogue search order
- `~/.claude/settings.json` — 20 keys; `model: "openrouter/hy3"`; `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` set **alongside** `replaceBuiltInOptions: true` (mutually cancelling)
- `…\claude-code-router\bin\ccr-claude-code-api-key-default-claude-code.cmd` — rotating `ccr-profile-<random>` secret

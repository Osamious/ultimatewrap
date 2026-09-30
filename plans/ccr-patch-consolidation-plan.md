# CCR patch consolidation + doctor coverage + CCR 3.1.1 sandbox trial

Status: PLAN ONLY (nothing executed, nothing written except this file). Date: 2026-09-30.
Closes the deferred follow-up Osamious/ultimatewrap#98 (one apply script for the CCR patches). Cross-refs: uw#97/#99/#109, CCR#1775/#1777.

---------------------------------------------------------------------------------------------------

## 0. Findings from read-only investigation that change the brief (read first)

1. **The installed `cli.js` is CRLF, not LF.** Measured: 8,896 `\r\n`, 0 bare `\n` (sha256 `160bf3ff...3ae168`, 2,309,033 bytes, as stated). The stock backup `cli.js.bak-timeout-fix` (sha `94aac2d2...05db`, 2,299,525 bytes) is LF. Arithmetic: 2,299,525 + 8,896 (CRs) = 2,308,421 = `cli.js.bak-timeout` (K7 only, CRLF). So "stock" has an unknown line-ending provenance: the file npm shipped may have been LF and got converted when K7 was first patched, or shipped CRLF. Consequence: the script must be byte-preserving (see 1.3) and must NOT normalise; and the pristine store must be seeded from evidence, not assumed (see 1.5, open question Q2).
2. **The five patches are exactly four differing lines in `cli.js` plus two sites in `index.js`.** Verified by line-wise diff of `cli.js.bak-timeout-fix` (CRLF-normalised) against the installed file: only lines 304 (Pd, +453 bytes), 305 (QQe, +158), 7897 (K7, +0: `5e3`->`2e4`), 8869 (yx, +1: `3e4`->`12e4`) differ; delta 453+158+1 = 612 = 2,309,033 - 2,308,421. The cumulative snapshots are consistent: `bak-timeout` (K7) -> `bak-metadata-cache` (+yx, +1 byte) -> `bak-findprovider-cache` (+Pd, +453) -> installed (+QQe, +158). `bak-preinstrument-pmm` and `-pmm2` are byte-identical to the installed file (a later instrumentation experiment, restored).
3. **`ai-gateway` `dist/index.js` is LF, has exactly the two error-detail sites patched** and `index.js.bak-error-detail` (sha `088a1dac...f9f`) is its stock. `index.js.bak-max-completion-tokens` is byte-identical to the current patched file (no sixth patch exists). ai-gateway version is 1.0.18 (the version recipe E was verified against).
4. **Every recipe is a single-line replacement** (no CR/LF inside find or replace), so CRLF/LF does not affect matching; it only matters for how the file is read/written (bytes must round-trip untouched).
5. **Idempotency trap found in the real replacement text:** the Pd step 1 replacement *contains* its own stock anchor (`...function Pd(e){` is the tail of the replacement). A naive "count(find)==1 => stock" test would re-apply and double-patch. Fixed by (a) anchoring step 1 on `Ag;function Pd(e){` (the replacement puts text between `Ag;` and `function Pd`, so the anchor does not survive), and (b) a recipe validator test: `!replace.includes(find)` for every step, and detection checks the *applied* count first.
6. **Doc drift confirmed:** installed markers are `UW_PD_CRYPTO`, `UW_PD_MAX`, `UW_pdc` (plan text says `UW_PDC`). The recipe module becomes the single source; the two plan files get a one-line corrective note (Stage 1, step S8).
7. `harness/scratch/` still holds a previous 3.0.22 sandbox tree (`appdata`, `localappdata`, `daemon-env.json`...). The 3.1.1 trial must use a different root (`scratch31`) and must first prove no daemon is running from the old one.
8. `keysync/ccr-patch-error-detail.mjs` is referenced by nothing except itself (and a stale state file); the only external references are commit `582ac0e` and issue #109 in prose.

---------------------------------------------------------------------------------------------------

## 1. PART 1 - `keysync/ccr-patch.mjs` (one command, five patches)

### 1.1 Goal
`node keysync/ccr-patch.mjs` (= `--check`) reports the state of patches A-E read-only; `--apply` applies whatever is missing, safely and idempotently; `--revert` restores stock. No gateway restart, no secret access, install path from `CONTRACT.installDir`.

### 1.2 Decision: E is folded in; the old script becomes a shim
- Fold E in: same install tree, same failure event (`npm i -g` reverts both), same operator intent ("one command"). One pristine store, one report, one exit code.
- Keep `keysync/ccr-patch-error-detail.mjs` as a ~10-line **shim** that calls `ccr-patch.mjs --only E` with the same flags and passes the exit code through; delete its hardcoded path, its `FROM`/`TO`, and its `.bak-error-detail` logic (the existing `.bak-*` files stay on disk untouched; never deleted). Justification: near-zero cost, keeps the #109/commit-582ac0e prose valid, and avoids a second copy of `FROM`/`TO` that could drift from the recipe. Behavioural difference to note in the shim header: `--check` now exits non-zero when not applied (old one always exited 0).

### 1.3 Design (recipes as data, mechanism as code)
Module split (writers serialise on the shared marker module; see stage order):

- **`menu/ccr-patches.mjs`** (NEW; pure: no fs writes, no imports, no path literals). Location rationale: `menu/` already holds `ccr-client.mjs`; `doctor.mjs` (menu/) and `keysync/ccr-patch.mjs` both import it; a doctor->keysync import would drag in CLI side effects, and `keysync/keysync.mjs` is heavy. It contains no `claude-code-router|node_modules|.claude|APPDATA|127.0.0.1` text, so `test/contracts.test.mjs` "no file outside the two contract modules names ..." passes with NO new allowance. It is not imported by `menu/uwpick.mjs` or anything in the picker's graph (add a test that asserts this).
  Exports: `PATCHES` (frozen array), `MARKERS` (id -> string[]), `classify(text, patch)`, `applyPatch(text, patch)`, `revertPatch(text, patch)`, `validateRecipes()` (used by tests).
  Recipe shape:
  ```
  { id: "A"|"B"|"C"|"D"|"E", title, file: "cli"|"gatewayLib",
    steps: [{ find, replace, count }],          // exact strings, count = expected occurrences of find in STOCK
    guards: [{ token, count }],                 // e.g. D: token "QQe" must occur exactly 2 times (stock AND patched)
    markers: [string...],                       // strings that must all be present when applied (doctor + script share)
    detect?: (text) => {state, value},          // OPTIONAL semantic detector for A and B (numeric threshold, see 1.4)
    severity: "red"|"amber",                    // doctor policy, see Part 2
    verifiedFor: { ccr: <read from CONTRACT at runtime>, gatewayLib?: "1.0.18" } }
  ```
  Invariants enforced by `validateRecipes()` and its unit test: no `\r`/`\n` in any find/replace; `!replace.includes(find)`; steps within a recipe do not overlap; every marker is contained in some `replace`; ids unique.
- **`keysync/ccr-patch.mjs`** (NEW; all fs/side-effect logic). Exports `run(argv, deps)` with injectable `installDir`, `storeDir`, `version`, `libVersion`, `nodeCheck`, `now`, `out`; runs `run(process.argv.slice(2), realDeps)` only when invoked directly. `realDeps.installDir = CONTRACT.installDir` (imported from `../menu/ccr-client.mjs`; no `C:`/`nvm4w` literal anywhere in the script, enforced by a test that greps the script minus comments).
- **`menu/ccr-client.mjs`** (contract module; the one file allowed to know CCR's layout) gains: `CONTRACT.gatewayLibBundle` (= `<installDir>/node_modules/@the-next-ai/ai-gateway/dist/index.js`) and `gatewayLibVersion()` (reads that package's `package.json`, null on failure). No other change.

### 1.4 Recipes (ground truth extracted from the installed file; verify, do not retype)
Executor must NOT hand-type replacements from prose. Extract them mechanically from the installed `cli.js` vs `cli.js.bak-timeout-fix` and from `index.js` vs `index.js.bak-error-detail`, then prove them with the round-trip test in 1.8. The texts below are what the extraction yielded on 2026-09-30 (single line each; `...` never appears in real recipes).

| id | file | step find (stock, count) | step replace |
|----|------|--------------------------|--------------|
| A K7 handshake | cli | `var PN="gateway",K7=5e3,` (1) | `var PN="gateway",K7=2e4,` |
| B yx saveConfig | cli | `"CCR_SERVICE_INSTANCE_TOKEN",pdt=2e3,yx=3e4,` (1) | `"CCR_SERVICE_INSTANCE_TOKEN",pdt=2e3,yx=12e4,` |
| C Pd cache, step 1 | cli | `Ag;function Pd(e){` (1) | `Ag;var UW_PD_CRYPTO=require("node:crypto"),UW_PD_MAX=512;function UW_pdc(){return UW_pdc.m\|\|(UW_pdc.m=new Map())}function Pd(e){` |
| C Pd cache, step 2 | cli | `let n=AQe(t.providers,e);return n?{loadedFrom:t.loadedFrom,matchedBy:n.matchedBy,modelDisplayNames:hM(n.entry.modelDisplayNames),modelMetadata:hM(n.entry.modelMetadata),models:n.entry.models,provider:n.entry.provider,providerName:n.entry.providerName}:{loadedFrom:t.loadedFrom,models:[]}}` (1) | see C2 block below |
| D QQe cache | cli | `function QQe(e){return new Set([e.name,e.id,e.provider,Cr(e)].map(t=>t?.trim().toLowerCase()).filter(t=>!!t))}` (1); guard token `QQe` = 2 (stock and patched) | see D block below |
| E error detail | gatewayLib | `message:"All target providers failed.",` (2) | the `TO` constant in `keysync/ccr-patch-error-detail.mjs` lines 65-70 (move verbatim into the recipe) |

C2 replacement (one line):
```
let UW_k;try{UW_k=UW_PD_CRYPTO.createHash("sha256").update(JSON.stringify([e?.providerPresetId??"",e?.baseUrl??"",e?.name??"",e?.providerIds??[]])).digest("base64")}catch{UW_k=void 0}let UW_c=UW_pdc();if(UW_k!==void 0&&UW_c.has(UW_k))return UW_c.get(UW_k);let n=AQe(t.providers,e);let UW_v=n?{loadedFrom:t.loadedFrom,matchedBy:n.matchedBy,modelDisplayNames:hM(n.entry.modelDisplayNames),modelMetadata:hM(n.entry.modelMetadata),models:n.entry.models,provider:n.entry.provider,providerName:n.entry.providerName}:{loadedFrom:t.loadedFrom,models:[]};if(UW_k!==void 0){UW_c.size>=UW_PD_MAX&&UW_c.clear(),UW_c.set(UW_k,UW_v)}return UW_v}
```
D replacement (one line):
```
var UW_QQE_CACHE=new WeakMap();function QQe(e){let UW_QQE_C=UW_QQE_CACHE.get(e);if(UW_QQE_C)return UW_QQE_C;let UW_QQE_V=new Set([e.name,e.id,e.provider,Cr(e)].map(t=>t?.trim().toLowerCase()).filter(t=>!!t));return Object(e)===e&&UW_QQE_CACHE.set(e,UW_QQE_V),UW_QQE_V}
```
Markers: A none beyond numeric detect; B none (numeric detect); C `UW_PD_MAX=512`, `UW_PD_CRYPTO`, `UW_pdc`; D `UW_QQE_CACHE=new WeakMap`, `UW_QQE_V`; E `const _d=t&&(t.details?.error?.message` (x2 sites).

Semantic detectors (A, B) preserve today's doctor behaviour: A anchors on the stable literal `var PN="gateway",` and reads the first numeric after it (identifier-agnostic, >= 20000 passes, so `zP=2e4` is green: existing tests rely on this). B anchors on the stable literal `"CCR_SERVICE_INSTANCE_TOKEN",` and reads the SECOND numeric assignment after it (`yx`), threshold >= 120000; if the pattern fails -> "anchor gone" (amber, stale). Apply for A/B still uses the exact-string steps (version-locked); detection is tolerant, apply is strict.

### 1.5 Script behaviour
CLI: `node keysync/ccr-patch.mjs [--check|--apply|--revert] [--only A,C,...] [--force-version] [--seed-store]`. Default `--check`. Exit codes: 0 = everything as asked (check: all five applied; apply/revert: done or no-op); 1 = refusal (unexpected count, syntax gate, version guard, sha mismatch); 2 = target missing/unreadable; 3 = `--check` found patches not applied (a state, not an error).

Algorithm (per file; all files planned before any write):
1. Resolve targets from `CONTRACT.installDir`/`gatewayBundle`/`gatewayLibBundle`. Read installed version (`ccrVersion()`, `gatewayLibVersion()`).
2. **Version guard:** `--apply` refuses when installed CCR version != `CONTRACT.verifiedVersion` (or ai-gateway version != recipe's `verifiedFor.gatewayLib` for E) unless `--force-version`; `--force-version` never bypasses the count assertions.
3. Read bytes as a **latin1** string (lossless byte<->char mapping; find/replace are ASCII), so CR/LF, BOM and any non-ASCII bytes round-trip exactly; write back as latin1 Buffer. Never normalise line endings. (Do NOT pass a latin1 string through `menu/atomic.mjs` `writeAtomic` as text - it would UTF-8 encode it; pass a `Buffer`, which `fs.writeFileSync` accepts, or write the temp file in the script.)
4. Classify each recipe: `applied` (applied-count check first, guards hold), `stock` (every step's find count == expected AND applied-count 0), or `unexpected` (anything else, including partial/mixed states, guard token count != 2 for D). `unexpected` => refuse that file, no writes anywhere, print counts per step.
5. Compute the new text by applying only `stock` recipes for the requested ids. Assert post-state: each applied recipe classifies `applied`, guards hold, byte length delta equals sum of (replace.length - find.length) x count.
6. **Syntax gate:** write the candidate to a temp file **in the same directory with the same extension** (`cli.uwpatch-<pid>.js`, so the nearest `package.json` "type" governs module goal), run `node --check` on it (`execFileSync(process.execPath,["--check",tmp])`), delete it. Baseline: first `node --check` the unmodified text the same way; if the baseline fails the gate is meaningless -> refuse with that reason. Injectable (`deps.nodeCheck`) for tests.
7. **Pristine store** `~/.uw/ccr-pristine/<version>/` (outside `node_modules`, survives `npm i -g`): `<fileKey>.<pristineSha256[0:16]>.orig` (exact bytes) + `manifest.json` `{ccrVersion, files:{<fileKey>:{relPath, pristineSha256, pristineBytes, patchedSha256, provenance:"captured"|"reconstructed", at, patchIds}}}`, written atomically (temp+rename). Written BEFORE the target is touched, only when the file is currently stock (all requested recipes `stock`); a pre-existing entry for the same version+sha is verified (sha of stored file) not overwritten.
8. **Atomic write:** temp file in target dir (the one already syntax-gated) -> `fs.renameSync` over the target; EPERM/EBUSY retried 3x with backoff then a clear error; on any failure delete temp, leave target untouched. Two files: write E's file first then `cli.js`; if the second write fails, restore the first from its pristine/pre-image (kept in memory) and report.
9. Post-write: re-read, recompute sha256, re-classify from disk, print `pre sha -> post sha` per file. Never print file contents or service.json.
10. Output tail: `Restart required: the running gateway still holds the previous code. ccr stop && ccr start --no-open (this script never restarts it). Until then \`uw doctor\` reads the FILE, not the process: green with a stale process is possible.` plus the doctor wording: "RED = A or C missing on the verified version; AMBER = B, D, E missing, or any state on an unverified version."
11. **`--revert`:** whole file: if the store has an entry for this version and the file's current sha == recorded `patchedSha256`, restore the stored original byte-exactly (atomic, syntax gate skipped because it is the original) and verify sha == `pristineSha256`. `--only X`, or a current sha that differs from the recorded one (someone edited it since), falls back to **inverse recipes** (replace->find with the same exact-count assertions). Refuse if neither applies. Reverting never deletes store entries.
12. **`--seed-store`** (the "already patched today" case): reconstruct pristine by inverse-applying all recipes in memory; assert forward re-application reproduces the current sha exactly; store with `provenance:"reconstructed"`. Cross-check (optional, executor asks first because it needs network read): `npm pack @musistudio/claude-code-router@3.0.22 --pack-destination <tmp>`; if the tarball's `dist/main/cli.js` sha equals the reconstructed sha, upgrade provenance to `"captured"` (this also settles the CRLF-vs-LF provenance in 0.1); if it differs only by line endings, record both. Never deletes the legacy `cli.js.bak-*` files.

### 1.6 What the script must never do
Write outside `installDir` and `~/.uw/ccr-pristine`; touch `service.json`/settings/APPDATA; restart or contact the gateway; print secrets; run against a target whose classification is `unexpected`; use `-g`/npm.

### 1.7 File-by-file changes (Part 1)
| file | change |
|------|--------|
| `menu/ccr-patches.mjs` | NEW recipes + `MARKERS` + classify/apply/revert/validate (pure) |
| `menu/ccr-client.mjs` | add `CONTRACT.gatewayLibBundle`, `gatewayLibVersion()` (frozen contract keeps everything else) |
| `keysync/ccr-patch.mjs` | NEW CLI (`run(argv, deps)`) |
| `keysync/ccr-patch-error-detail.mjs` | reduce to shim delegating to `ccr-patch.mjs --only E` |
| `test/fixtures/ccr-3.0.22-hunks.json` | NEW: the five stock hunks with +-80 chars context, extracted from the real stock bytes (no secrets; contains only minified code) |
| `test/ccr-patch.test.mjs` | NEW (see 1.8) |

### 1.8 Test plan (Part 1) - fixtures only, temp dirs, no writes to any real install
Synthetic install tree per test: `<tmp>/pkg/package.json {"version":"3.0.22"}`, `<tmp>/pkg/dist/main/cli.js` built from the hunks fixture (+ filler), `<tmp>/pkg/node_modules/@the-next-ai/ai-gateway/{package.json {"version":"1.0.18"},dist/index.js}`; `storeDir` in temp; `nodeCheck` stubbed unless the test is the real-syntax one. No secret-shaped literals anywhere (fake-secret rule; there are no keys in this domain).
1. Recipe validator: no newlines, `!replace.includes(find)`, no overlapping steps, markers contained, ids unique.
2. Check on stock fixture: exit 3, five `NOT APPLIED`, zero writes (mtime + sha unchanged).
3. Apply -> exit 0, all five `applied`, sha changed, byte delta == 612 for the real-shaped hunks; second `--apply` is a no-op (sha identical, "already applied").
4. Idempotency of C step 1 (the self-containing replacement): apply twice never yields two `UW_PD_MAX`.
5. Wrong-count refusal: fixture with the K7 anchor duplicated / missing / QQe token count 3 / E with 1 site: exit 1, no file changed (both files, sha compare), message names the step and counts. Partial state (C step 1 applied, step 2 not): `unexpected`, refuse.
6. Syntax-gate failure: `nodeCheck` returns failure for the candidate (and one test with a recipe whose replace breaks syntax, real `node --check`): exit 1, target untouched, temp file removed, no store entry written for a refused apply.
7. Revert round trip: apply then `--revert` -> file byte-identical to the original fixture (sha equal); `--only C --revert` via inverse recipes leaves A/B/D/E applied; store-restore path chosen when sha matches recorded, inverse path when the file was edited afterwards.
8. Version mismatch: installed 3.1.1 -> `--apply` exit 1 naming both versions; `--force-version` still refuses on count mismatch (fixture is stock-shaped for 3.0.22 but version 3.1.1 -> proceeds; a 3.1.1-shaped fixture with unknown anchors -> refuses).
9. CRLF handling: same fixture with every `\n` -> `\r\n`: apply then check green, revert returns the CRLF original byte-exact; a mixed-ending fixture round-trips byte-exact; a file with a non-ASCII byte sequence (UTF-8 bytes in a comment) round-trips byte-exact (latin1 decode/encode proof).
10. Store: entry keyed by version+sha, re-apply after reinstall (new stock fixture, same version) re-captures pristine; two versions do not collide; `--seed-store` on an applied fixture reconstructs pristine and its forward re-application reproduces the sha.
11. Atomicity: simulate rename failure (inject) -> target unchanged, no `*.uwpatch-*` debris, second-file failure rolls back the first.
12. Boundary tests: the script text contains no `nvm4w`/`C:\` literal outside comments; `menu/ccr-patches.mjs` passes the existing needle scan unchanged; picker graph (`menu/uwpick.mjs` transitive imports) does not include `ccr-patches.mjs`.
13. Shim: `ccr-patch-error-detail.mjs --check` output/exit matches `ccr-patch.mjs --check --only E`.
14. Read-only golden (skipped when the real install is absent or its sha differs): `--check` against the real install reports A-E `applied`. Never writes.

---------------------------------------------------------------------------------------------------

## 2. PART 2 - `menu/doctor.mjs` coverage for all five patches

### 2.1 Policy (recommended defaults; user may override, Q1)
| id | check name | verdict when missing (installed == verified version) | why |
|----|-----------|------------------------------------------------------|-----|
| A | `ccr-gateway-patch` (existing name kept) | RED | intermittent under load, reads as flakiness; already happened once |
| C | `ccr-pd-cache-patch` | RED | the Sept 2026 incident: 7.3 s/request at 46 providers (worse at 63), avg 30 s / worst 93 s in production; silent, degrades every request |
| B | `ccr-savecfg-patch` | AMBER | `saveConfig` timeout 30 s vs 120 s: fails LOUDLY at a deliberate operator action (keysync apply), never degrades routing |
| D | `ccr-findprovider-patch` | AMBER | measured saving ~270 ms/request, below its own 300 ms gate; kept on user decision; a loss is a slowdown, not an outage |
| E | `ccr-error-detail-patch` | AMBER | diagnostic text only; no functional effect |
Common rules: `applied` = GREEN with evidence `patched (<marker or value>)`; `anchor gone` = AMBER "CCR was rebuilt; this check needs re-deriving; do NOT assume the patch is absent" (existing wording); `unexpected/modified` (markers present but not exactly the recipe, or partial) = AMBER naming counts; **installed CCR version != `CONTRACT.verifiedVersion` => every missing patch is AMBER** ("recipes verified for X, installed Y; Pd/QQe are upstream-fixed from 3.1.0 so a missing C/D may be correct - run `node keysync/ccr-patch.mjs --check`"). The missing-patch evidence names the exact remedy `node keysync/ccr-patch.mjs --apply` then restart. All checks read-only.

### 2.2 File-by-file
| file | change |
|------|--------|
| `menu/doctor.mjs` | import `PATCHES`/`classify` from `./ccr-patches.mjs`; keep `checkCcrPatch`, `GATEWAY_ANCHOR`, `GATEWAY_TIMEOUT_MIN_MS` exports and behaviour byte-compatible (re-implemented on the recipe's `detect`, existing 6 doctor tests unmodified and green); add `checkCcrPatches({cliText|read, libText, version, verified, libVersion})` returning the B-E checks; add optional `ccrPatches` arg to `diagnose()`; in `main()` read `cli.js` ONCE through a memoised reader shared by A and B-D (2.3 MB, ~ms) and read the ai-gateway file separately; if the ai-gateway file is absent E is AMBER "not at <CONTRACT path>; if CCR now bundles ai-gateway inside cli.js, re-derive". Paths only from `CCR.CONTRACT` (`gatewayBundle`, `gatewayLibBundle`). Boundary allowlist: none needed. |
| `test/doctor.test.mjs` | append tests below |
| `test/contracts.test.mjs` | append: `ccr-patches.mjs` has no path literals and is outside the picker graph (if not already in ccr-patch.test.mjs, keep it in ONE place) |

### 2.3 Doctor tests (in the existing style: inject text, never touch the disk)
For each of B, C, D, E: stock text -> expected verdict (RED for C, AMBER for B/D/E) with evidence naming `ccr-patch.mjs --apply` and the restart; applied -> GREEN; anchor gone -> AMBER "Do NOT assume"; markers present but text edited -> AMBER "modified"; version mismatch -> AMBER regardless of severity; CRLF variant of every fixture -> same verdict; a shared-marker test: every string in `MARKERS` appears in the recipe's replace text and doctor evidence never contains a marker not in `MARKERS` (single source); `diagnose()` with all five: worst verdict wins, RED sets exit 1 (the existing `main()` contract); the 6 existing checkCcrPatch tests unchanged.

---------------------------------------------------------------------------------------------------

## 3. Stage order, roles, and gates (Parts 1-2)

Serialise writers on the shared module; nothing else runs concurrently on these files. Before any edit: `git status --short menu/ keysync/ test/` and confirm with `main` that no other agent (exec-l0-status-columns*, review-picker, etc.) has `menu/doctor.mjs`, `menu/ccr-client.mjs` or `test/doctor.test.mjs` open; work on the current tree, do not reset/checkout. No commit unless the user asks (then trailer per the session attribution).

| step | role | work | checkable exit criterion |
|------|------|------|--------------------------|
| S1 | executor | `menu/ccr-patches.mjs`, `ccr-client.mjs` additions, `test/fixtures/ccr-3.0.22-hunks.json` (extract mechanically) | `node -e "import('./menu/ccr-patches.mjs').then(m=>console.log(m.validateRecipes()))"` ok; sha proof below |
| S2 | executor | `keysync/ccr-patch.mjs` + shim | `node keysync/ccr-patch.mjs --check` exits 0/3, prints 5 lines, writes nothing |
| S3 | test-engineer | `test/ccr-patch.test.mjs` (1.8) | `node --test test/ccr-patch.test.mjs` all pass |
| S4 | executor | doctor changes (Part 2) | existing doctor tests still pass |
| S5 | test-engineer | doctor + contracts tests (2.3) | `node --test test/doctor.test.mjs test/contracts.test.mjs` |
| S6 | code-reviewer (separate lane; also security-reviewer for the write path) | review S1-S5; explicitly the atomic write, latin1 handling, revert paths, real-install safety | written findings; fixes go back to executor |
| S7 | verifier | full run + real-install read-only proofs (below) | all acceptance criteria |
| S8 | writer | one-line "as-built: installed markers are UW_PD_CRYPTO/UW_pdc" notes in `plans/ccr-metadata-cache-patch-plan.md` and `plans/ccr-findprovider-cache-patch-plan.md`; a short "CCR patches" section in the runbook (docs/CCR-Stack-Runbook.md is untracked: confirm with user before editing) | grep shows the corrected marker |

### 3.1 Acceptance criteria (commands)
1. `node --test test/*.test.mjs` -> only the 2 known failures (`test/doctor.test.mjs` checkHandoff); new tests all pass; run twice (no order dependence).
2. `node keysync/ccr-patch.mjs --check` against the REAL install -> exit 0, all five `applied`; `sha256sum` of real `cli.js` still `160bf3ff4142b76b664a57b9f15e8abdc6bc3220faad1e4b1ec850c57b3ae168` and real `index.js` still `1cf1eabe9e7c2d174927c88acb40de6f4297b06318ed325b69a1cacc51035438` (recorded before and after the whole verification).
3. `node keysync/ccr-patch.mjs --apply` against the real (already patched) install -> "already applied", no write, shas unchanged (idempotent no-op; the only real-install command the verifier runs besides `--check`). `--revert` is NEVER run on the real install.
4. Recipe correctness proof (verifier, read-only, driver script through `run({installDir: <tmp copy>})`): copy the real `cli.js`/`index.js` into a temp tree; inverse-apply all recipes; CRLF->LF-normalised `cli.js` sha == `94aac2d2f15ba612c17c4c35e6bd84a4a1c957107913d9a7a0847cd9c88505db` (bak-timeout-fix), `index.js` sha == `088a1dac2b56319ca15613ba45b4501ea76c2d5b4cbbda13b040e3964f588f9c` (bak-error-detail); forward re-apply reproduces the real shas; apply/revert round trip on the copy is byte-exact.
5. `node menu/doctor.mjs` (read-only; note it probes the live gateway RPC as today) prints a line for each of `ccr-gateway-patch`, `ccr-savecfg-patch`, `ccr-pd-cache-patch`, `ccr-findprovider-patch`, `ccr-error-detail-patch`, all GREEN on the current machine; total added runtime < 500 ms.
6. Negative doctor proof on a temp copy: swap in `cli.js.bak-timeout-fix` text via the injected reader in a test (not on the real file) -> A RED, C RED, B/D AMBER.
7. `grep -nE "nvm4w|C:\\\\" keysync/ccr-patch.mjs` (excluding comments) -> none; contracts test green.
8. `git status --short` shows only the files in 1.7/2.2 (plus the untracked pre-existing ones); `git diff --stat` on `menu/doctor.mjs` shows no change outside the patch-check region and `diagnose`/`main` wiring.

### 3.2 Risks and rollback (Parts 1-2)
| risk | mitigation | rollback |
|------|-----------|----------|
| script corrupts the live `cli.js` | plan-all-then-write, syntax gate on candidate, atomic rename, sha assertions, real-install verification is read-only/no-op | restore from store, or from the legacy `cli.js.bak-findprovider-cache`/`-metadata-cache`/`-timeout` snapshots (kept); then restart |
| the running gateway holds old code after apply/revert | printed restart notice; doctor already flags installed!=running version | `ccr stop && ccr start --no-open` (announce first: the live gateway serves active sessions) |
| latin1/CRLF handling corrupts bytes | dedicated round-trip tests (mixed endings, non-ASCII) | none needed: byte-identical or refused |
| doctor turns RED on an environment that is fine (C on 3.1.x) | version-mismatch demotes to AMBER | flip severity in one recipe field |
| two agents editing `menu/doctor.mjs` | pre-edit status check + serialisation | `git diff` review; no resets |
| recipe drift vs reality | mechanical extraction + inverse-sha proof (criterion 4) | fix recipe, re-run proof |

---------------------------------------------------------------------------------------------------

## 4. PART 3 - CCR 3.1.1 sandbox trial (staged, approval-gated)

### 4.0 Goal and principle
Decide whether CCR 3.1.1 (Pd/QQe fixes upstream in 3.1.0: 09d41b0a, 687b84f2, 9f45399b) can replace 3.0.22 and which of A-E are then unnecessary, WITHOUT any write to real state. Principle from the memory notes: isolation is proven **by construction and by canary**, never inferred from where the tool's own data lands, and every knob is force-set on the command line each rebuild ("set" is not "known to be controlled"). The 3.1.x port model changed (`saveAppConfig` strips `gateway.coreHost/corePort`; host/port come from compile options; `CCR_WEB_PORT` env still honoured), so the 3.0.22 assumption "gateway ports are DB-config-controlled" (harness `assertPayloadIsolated`, `bootstrap.mjs`) is **not carried over**: it is re-derived in stage 1b and re-verified at first start.

### 4.1 Where things live (no edits to the working 3.0.22 harness)
Trial code goes in `harness/trial31/` (config31.mjs, guard31.mjs, preload-guard.cjs, start31.ps1, verify-isolation31.mjs, census31.mjs, teardown31.mjs, stub-upstream.mjs, measure-*.mjs). It IMPORTS `makeTripwire`/`listenerPid` from `harness/guard.mjs` (those are root-independent live-state watchers) but not `assertPayloadIsolated`/`assertIsolatedConfig` (they encode 3.0.22 config keys). `harness/config.mjs`, `guard.mjs`, `bootstrap*.mjs`, `teardown.mjs`, `start.ps1` are not modified. Sandbox root `C:\Users\osami\.uw\harness\scratch31` (owner-only ACL as `start.ps1` does), separate from the existing `harness\scratch` 3.0.22 tree. Ports: trial gateway 39456 is reused ONLY if no 3.0.22 harness daemon exists; otherwise use 39466/39467/39468 (web); the stage-1 preflight asserts which. All ports are outside {3456, 3457, 3458, 4517}.

### 4.2 Stage 1 - sandbox install + isolation proof, ZERO provider traffic

**1a. Build the isolation apparatus offline (no CCR, no network, no gate needed).** executor + test-engineer, reviewed by security-reviewer:
- `preload-guard.cjs`, injected with `NODE_OPTIONS=--require <abs path>` (precedent: UW already ships `gateway-proxy-preload.cjs`): refuses (throws, logs to `scratch31\violations.log`) any (i) `net.Server.listen` outside the allowlist [39456-39470], (ii) `net.Socket.connect`/`dns.lookup` to a non-loopback address (airgap: also prevents accidental provider traffic BY CONSTRUCTION), (iii) fs write/rename/copy/unlink/mkdir/symlink (sync, callback, promises, streams via `open` flags) under protected roots: real `~\.claude`, real `%APPDATA%\claude-code-router`, real `%LOCALAPPDATA%\Claude-3p`, `~\.codex`, real `~\Downloads` and anything outside `scratch31` + OS temp, (iv) `child_process` spawn/exec of `reg`/`setx`/`powershell` whose args match registry/`SetEnvironmentVariable`/`PATH` writes. Fail-closed (daemon crashing is an acceptable outcome of a violation).
- Candidate mechanism B evaluated side by side: Node's permission model (`node --permission --allow-fs-write=<scratch31> ...`). Uncertain items to settle by canary, not assumption: whether child node processes inherit the restrictions, whether `--allow-addons`/`--allow-child-process` are required (native sqlite) and how much they weaken it. Adopt A, B or both by test result.
- Environment redirect (belt to the preload's braces): `USERPROFILE`, `HOME`, `HOMEDRIVE/HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP` all -> `scratch31\home|roaming|local|tmp` (Windows `os.homedir()` follows `USERPROFILE`, which redirects `~/.claude/settings.json`, `~/.codex/config.toml` and the takeover targets into the scratch home IF CCR derives them from `homedir()`; if a path is a persisted absolute string it is NOT redirected, which is exactly what the 2026-09-08 incident hit - so census 1c must decide which). Plus every `CCR_INTERNAL_*` var (`APP_DATA_DIR`, `HOME_DIR`, `USER_DATA_DIR`), `CCR_CONFIG_DIR`, `CCR_WEB_HOST=127.0.0.1`, `CCR_WEB_PORT`, `CCR_WEB_AUTH_TOKEN` (a harness constant, not a real token), `CCR_GATEWAY_CONFIG_TIMEOUT_MS` left UNSET for the default-behaviour run.
- Tripwire extended (`makeTripwire` with extra files): real `~\.claude\settings.json`, `settings.local.json`, `~\.codex\config.toml`, `%LOCALAPPDATA%\Claude-3p` tree, `~\Downloads` listing, HKCU user PATH string, and in real `%APPDATA%\claude-code-router` ONLY the files that must not change (`service.json` hash, `global-profile-takeover.json` hash, `bin\` listing) - not the whole tree (the live gateway writes `usage.sqlite` continuously; watching it would trip constantly). A pre-trial copy of the real `settings.json` goes to `scratch31\backup\` (never printed) for instant restore.
- Preload/guard unit tests run against temp dirs only (canary writes to a fake "protected" root, a fake non-loopback connect, a fake `reg add` spawn, a 3rd-party child process). Acceptance: `node --test harness/trial31/*.test.mjs` passes; every canary produces a blocked-violation log line and no side effect.
- Review lane: code-reviewer + security-reviewer read the guard for bypasses (native addons, `fs.promises`, worker threads, `process.binding`); documented residual gaps go into the census as "covered by tripwire only".

**GATE G1 (explicit user approval): install.** Preceded by read-only `npm view @musistudio/claude-code-router@3.1.1 version bin scripts dependencies dist.tarball --json` (network read) to check for `preinstall/install/postinstall` scripts. Then, in a fresh empty directory `scratch31\npm`:
`npm install --prefix scratch31\npm --ignore-scripts --cache scratch31\npm-cache --userconfig scratch31\empty.npmrc --no-audit --no-fund @musistudio/claude-code-router@3.1.1` - NEVER `-g`, NEVER on PATH; `--ignore-scripts` first (any lifecycle script is reviewed before being run manually). Exit criteria: real global 3.0.22 untouched (`ccr-patch.mjs --check` still 5x applied, shas unchanged, real `npm ls -g @musistudio/claude-code-router` unchanged), no new `%LOCALAPPDATA%\npm-cache` entries beyond baseline, tripwire green.

**1b. Static side-effect census (no execution of CCR).** `census31.mjs` greps the installed sandbox `dist` and writes `harness/trial31/census-3.1.1.md` covering: all `CCR_*`/`process.env.*` names; every `.listen(`/port default (expect 3456/3457/3458/4517 and how 3.1.x overrides them); every `homedir()`/`USERPROFILE`/`.claude`/`.codex`/`APPDATA`/`LOCALAPPDATA`/`Claude-3p` reference; takeover code (`global-profile-takeover`, `settingsFile` derivation: from `homedir()` or persisted absolute path); HKCU PATH splice code (`reg`, `setx`, `SetEnvironmentVariable`, `bin` dir install); every `spawn/execFile`; the timeout constants (K7 successor, `CCR_GATEWAY_CONFIG_TIMEOUT_MS` default, yx successor); the `ccr-router` plugin and the bundled ai-gateway version (needs >= 1.0.21 for the plugin); `usage_metadata`/`stream_metrics_json` DDL; how `bin` starts the daemon (so the trial launches `node <sandbox>\...\cli.js start` directly, not the PATH `ccr`). Output is a table: side effect | trigger | redirected by env? | blocked by preload? | watched by tripwire? Every row must have at least one "yes" in the last three columns or it blocks G2. architect reviews the census (read-only).

**GATE G2 (explicit user approval): first start of the sandbox gateway, zero providers.** Announce, then `start31.ps1`: preflight asserts (all must pass or abort before launching): live 3.0.22 gateway state recorded but untouched; no process listening on the trial ports; no daemon from the old `scratch` tree; sandbox tree empty of providers; preload present; env block printed WITHOUT the token; ports forced explicitly in the command being run (env AND any config key the census found - "set" is verified, not remembered). Launch `node <sandbox cli> start` with the full env; immediately (before anything else) run `verify-isolation31.mjs`: (1) `Get-NetTCPConnection -State Listen` for the daemon pid tree - every port in the allowlist, none in {3456,3457,3458,4517}; (2) tripwire assert; (3) `Select-String` real `~\.claude\settings.json` for `ANTHROPIC_BASE_URL|apiKeyHelper` -> no match; (4) sandbox `service.json` token equals the harness constant (proves env reached the daemon); (5) `getAppInfo` `configDir/dataDir/configDbFile` under `scratch31`; (6) the scratch home contains whatever takeover wrote (recorded, this IS measurement M7); (7) HKCU PATH unchanged, else immediate stop + PATH restore (restore write is pre-authorised in G2 as a cleanup of our own side effect); (8) violations.log empty or explained. Any failure: `teardown31.mjs` (scrub, stop pid tree, delete tree) and stop the trial. Exit criterion for stage 1: isolation proof report `harness/trial31/isolation-proof-3.1.1.md` with all eight checks green and ZERO outbound traffic (network connections of the daemon pid tree all loopback). Roles: qa-tester operates the start, verifier signs the proof.

### 4.3 Stage 2 - measurements (stub upstream; loopback only; no provider cost)

**GATE G3 (explicit user approval): load synthetic providers and run measurements.** `stub-upstream.mjs` on 127.0.0.1:39470 serves OpenAI-compatible and Anthropic-shaped endpoints with configurable behaviour (200 zero-latency, 401, 500, connection close), counts hits per route, records request bodies (for M6) - no real network, no keys. Providers are synthetic: names/`baseUrl` hostnames copied from the real key inventory's SHAPE (so `Pd`'s preset matching sees realistic URLs; never contacted because the preload's airgap blocks non-loopback), `api_key` = obvious placeholders built at runtime (no secret-shaped literals in files), `autoFetchModels` off, only the routed provider points at the stub. Quiet window: measure only while no other agent runs bench/probe traffic (check `refresh/bench-lock`; sample CPU before/after) because the machine is shared; alternate control and trial arms (A-B-A-B).

| id | measurement | method | go / no-go |
|----|-------------|--------|------------|
| M1 routing latency vs provider count | median and p95 of 30 sequential `POST /v1/messages` (after 5 warm-ups) through the gateway to the stub, N enabled providers in {1, 46, 63}; control arm = existing 3.0.22 harness (same script, same machine window) unpatched (recorded 7.3-7.5 s @46) and patched (1.0-1.16 s @46, ~730-850 ms with D) | GO: 3.1.1 median @63 <= 1.0 s AND <= 1.1x the 3.0.22-patched control @63; NO-GO if > 2x control or superlinear growth 46->63. State the population with every number ("median of 30 sequential requests, N providers enabled") |
| M2 handshake | 10 cold starts with the 63-provider config, default timeout (env unset); time-to-ready distribution; then `CCR_GATEWAY_CONFIG_TIMEOUT_MS=500` to prove the knob is honoured and capture the failure text | GO (A retired): 10/10 default starts succeed with >= 2x margin; else the launcher must set the env var (where the real daemon is started, `ccr-watchdog.ps1`) - a config change, not a file patch |
| M3 saveConfig | time the config-save RPC with the 63-provider, thousands-of-models payload (successor of `yx`) | GO (B retired): < 50% of the timeout; else env/config equivalent or B ported |
| M4 DB readers | dump `pragma table_info` of `usage_events`, `request_logs`, `usage_metadata`, `stream_metrics_json`; run `refresh/observe.mjs` USAGE_COLS/LOG_COLS checks and `menu/ccr-client.mjs` readers with `UW_CCR_DATA_DIR=scratch31\...` (read-only); send requests with `x-ccr-client: uw-probe` and confirm the `client` column | GO: all UW-read columns present with the same meaning; NO-GO for the observer/health readers if a column moved (then a contract update is a prerequisite) |
| M5 fallback | two stub providers, `Router.fallback` model-chain and a rule chain; cases: primary 500, primary 401, primary refused; check per-stub hit counts and `attempts` in the response/usage rows for whether the fallback leg re-hits the dead primary (upstream #1804, #1831) | informational unless the executor's read-only review of UW's live routing config shows it uses fallback/model-chain, in which case NO-GO until fixed; file findings |
| M6 plugin | `keysync/ccr-plugins` `uw-schema-sanitizer` loads next to the new `ccr-router` plugin on ai-gateway >= 1.0.21; send a schema that needs sanitising; the stub records the received body; run `node --test test/ccr-schema-sanitizer.test.mjs` unchanged | GO: plugin loads (log line), body reaches the stub sanitised, no load-order error |
| M7 takeover | contents of the scratch home after start (settings.json env keys, `.codex`), whether takeover fires with zero providers vs with providers, whether it honours redirected `USERPROFILE` | recorded; NO-GO if any real path is reachable only via tripwire-after-the-fact |
| M8 error text | force an all-providers-fail 502 via the stub's JSON error; capture client-visible `error.message`, `attempts[]` after PR #1773 | E retired if the upstream message is already surfaced in a shape at least as useful as recipe E's `provider: reason` |
| M9 rpc latency | `getAppInfo` and `getConfig` wall time (the doctor's ccr-rpc probe measured ~7.2 s vs 6 ms on 3.0.22; #1776) | informational |
| M10 real-traffic (OPTIONAL) | only if M8/M5 cannot be answered with the stub: <= 20 requests, `max_tokens` 8, one cheapest/free-tier provider, hard cost cap proposed at USD 0.10 total | **GATE G4, default NONE**; requires lifting the airgap for one named host in the preload allowlist |
| M11 keysync (OPTIONAL) | `node keysync/run.mjs --target isolated` against the sandbox, real key store -> real keys land in `scratch31` config DB; verifies saveConfig/APIKEYS handling end-to-end | **GATE G5, default NONE**; before approval read `keysync/run.mjs` around line 1651 to confirm what `isolated` writes and to where; airgap stays on; teardown scrubs and deletes the tree (SQLite WAL retains rows, so files are deleted, not just cleared) |

Deliverable: `harness/trial31/RESULTS-3.1.1.md` with the go/no-go table filled, raw numbers, per-patch verdict ("A retired / needed", ...), and the list of UW contract items to update (`CONTRACT.verifiedVersion`, `fingerprint`, readers) - the trial does NOT change `CONTRACT.verifiedVersion`, does NOT run `ccr-patch.mjs` against the sandbox (it is measured unpatched), and does NOT change the real install. Findings become GitHub issues at Osamious/ultimatewrap (`[PREFIX] short title`, per the file-findings rule) and upstream where reproducible.

### 4.4 Teardown and rollback (Part 3)
`teardown31.mjs`: scrub providers (only if any), stop the daemon pid tree, restore HKCU PATH from the tripwire baseline if it moved, delete `scratch31` (retry x3), assert the tripwire against baseline, print "live state unchanged". Live restore kit if the tripwire ever fires: `scratch31\backup\` copy of `settings.json` (hash-verified before use), the disconnect cleanup already used in earlier incidents (`keysync/finish-disconnect.mjs`). Real global CCR is never stopped, restarted, or upgraded by any step; `npm i -g` of 3.1.1 is a separate, later, user-approved migration that also re-runs `ccr-patch.mjs --check` to see which recipes still apply.

### 4.5 Approval gates summary (nothing below runs without an explicit yes from the user)
| gate | what | cost/risk |
|------|------|-----------|
| G0 | Part 1-2 implementation (no gate needed beyond this plan's approval); real-install commands limited to `--check`/idempotent `--apply` no-op | none |
| G1 | `npm view` + `npm install --prefix scratch31\npm --ignore-scripts` of 3.1.1 | network read/download, disk in scratch |
| G2 | first start of the sandbox gateway with zero providers, plus pre-authorised cleanup (PATH restore, teardown) if a tripwire fires | live-state risk if isolation fails; mitigated by preload + tripwire |
| G3 | synthetic providers + stub measurements (loopback only) | CPU contention with other agents; USD 0 |
| G4 | any real-provider traffic (default none; cap USD 0.10 / 20 requests if used) | money, key use |
| G5 | keysync `--target isolated` with the real key store (default none) | real keys copied into scratch |
| G6 (optional) | `attrib +R` on real `settings.json` during the trial as a fail-loud belt | touches real file metadata (reversible) |

### 4.6 Roles (Part 3)
executor: trial31 scripts and stub; test-engineer: guard/preload canary tests; security-reviewer + code-reviewer: isolation apparatus review; architect: census review; qa-tester: operates G2/G3 runs; verifier: signs isolation proof and result table (separate lane from the author); scientist optional for latency statistics; writer: RESULTS summary and runbook delta. Runs never overlap another agent's use of the live gateway (schedule the quiet window through `main`).

### 4.7 Trial acceptance criteria (commands)
1. Before/after each gate: `node -e` tripwire from `harness/guard.mjs` (`makeTripwire().assert(stage)`) passes; `Get-NetTCPConnection -State Listen` shows 3456/3457/3458 owned by the same live pids as before and nothing new outside the trial allowlist.
2. `node --test harness/trial31/*.test.mjs` passes before G1.
3. `node keysync/ccr-patch.mjs --check` (real install) is unchanged before/after (five applied, same shas).
4. `Select-String -Path "$env:USERPROFILE\.claude\settings.json" -Pattern 'ANTHROPIC_BASE_URL|apiKeyHelper'` -> no match after G2 (expected state as today; confirm today's baseline first).
5. `isolation-proof-3.1.1.md` exists with eight green checks; `RESULTS-3.1.1.md` has every M-row filled or explicitly marked skipped with reason.

---------------------------------------------------------------------------------------------------

## 5. Consolidated risks
1. Byte-level corruption of a 2.3 MB minified bundle by a patch tool (mitigated: latin1, gate, atomic, sha, tests, read-only real verification).
2. Doctor false RED after CCR upgrade (mitigated: version-mismatch demotion).
3. Pristine store built from a reconstruction is only as good as the recipes (mitigated: inverse-sha proof against the stock backups, optional `npm pack` cross-check).
4. Sandbox escape via hardcoded absolute paths/registry (mitigated: preload deny + env redirect + tripwire; residual: native/child-process bypass covered by tripwire only, documented in the census).
5. Port isolation mechanism changed in 3.1.x (mitigated: not assumed; forced in the command, checked by listening-port enumeration at first start).
6. Shared machine: measurements perturb or are perturbed by other agents (mitigated: quiet window, A-B-A-B interleave, CPU sampling).
7. Upstream fallback bugs #1804/#1831 could affect UW routing after an upgrade (M5).

## 6. Open questions for the user (short)
1. **Doctor severity:** A and C RED; B, D, E AMBER (rationale in 2.1). Accept, or make B/D RED too?
2. **Pristine store seeding:** may the executor run `npm pack @musistudio/claude-code-router@3.0.22` into a temp dir (network read, no install) to prove the stock file's real bytes/line endings, and then seed `~/.uw/ccr-pristine/3.0.22/` now (recommended), or only capture pristine on the next reinstall?
3. **Stage-3 scope:** stub-only measurements with the airgap on and NO real-provider traffic and NO real keys (recommended default; G4 and G5 stay off). Confirm, or name a cost cap/provider if you want M10 or the keysync-isolated run M11.
4. **Pre-authorisation:** in G2, is the automatic cleanup of our own side effects (restoring HKCU user PATH from baseline if the sandbox spliced it, deleting `scratch31`) pre-authorised, and do you want the optional real-`settings.json` read-only belt (G6)?
5. **Timing:** may Stage-3 measurement runs be scheduled in a quiet window (no bench/probe agents using the live gateway), coordinated through `main`?

(Old-script shim vs delete, marker module location and E folded in are decided above with reasons; say so only if you want them reversed.)

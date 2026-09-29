# C cases: provider and account actions, provider by provider

Audience: the project owner (Osama), who is the only person who can take these account and provider actions.
Written: 2026-09-29.

## What "C cases" means

A "C case" is a model route that does not answer because of an ACCOUNT or PROVIDER-SIDE condition, not because of a bug in UW and not because the model is gone for everyone. Only you (or the provider) can change that condition. This guide is about the cases you can try to fix without buying a plan. Where a step inherently costs money it is labelled **MONEY**. Money cases get a separate effort later, so here they only say what to check and when to stop.

## Where the numbers come from

All route counts, example ids and provider sentences come from the bench study of the 2026-09-29 probe sweeps: `plans/bench-study/models.csv`, `plans/bench-study/providers.csv` and `plans/bench-study/REPORT.md` (revision 2). That data is the merged `state/bench.json` with `generatedAt` 2026-09-29T14:29Z. A later `state/bench.json` (generatedAt 2026-09-29T16:51Z) exists after targeted re-probes of the `empty` and `timeout` rows; I compared it and the `auth` counts for every provider in this guide are identical in both files, so only the "how many other routes answer ok" figures differ slightly (noted where it matters). A "route" is one selectable picker row. Provider sentences are the redacted versions the study stores (keys masked, URLs shown as `[url]`); request ids are shown as `[id]` or `[tid]` placeholders and never copied here.

How this guide marks uncertainty: every step I could not check against public documentation carries the exact phrase "(not verified: confirm in the provider dashboard)". Where I checked a step against a public page, the page is cited. I did not read the vault, Credential Manager or CCR config, sent no request to any provider API, and ran no probe. I only read repo files, the study data, and public documentation pages.

---

## 1. Summary table (sorted by value for effort)

Action types: DASHBOARD (a setting in the provider's console), SUPPORT TICKET, KEY (the credential itself), MONEY (needs paying), WAIT (provider outage, re-check later). "Recovery" is the honest upper bound of routes that could turn `ok`, not a promise.

| # | Provider (section) | Routes | Cause | Action type | Effort | Expected recovery | Priority |
|---|---|---|---|---|---|---|---|
| 1 | openrouter `meta/muse-spark-*` (4.2a) | 4 auth (+1 `fetch failed` sibling) | 18+ age confirmation not done on the account | DASHBOARD | 5 min | up to 4 (5 with the sibling) | 1 |
| 2 | orcarouter free models (4.10) | 5 (recorded `rate`, will read `auth`) | Free models need a linked, established GitHub account | DASHBOARD | 10 min | up to 5 | 1 |
| 3 | cloudflare `llama-3.2-11b-vision-instruct` (4.8) | 1 of 8 | Meta license not yet accepted for the account | DASHBOARD-like (one direct call) | 10 min | up to 1 | 2 |
| 4 | openrouter `inkling*:free` (4.2b) | 2 | Unknown (truncated); paid twins already answer | DASHBOARD + one direct call | 15 min | 0 to 2 | 2 |
| 5 | alibaba (4.4) | 17 | Per-model or per-region entitlement ("Access denied") | DASHBOARD | 20 min | 0 to 17, likely a handful | 2 |
| 6 | sambanova (4.1) | 7 | Valid key, account has no credit (402) | MONEY | 15 min to check | up to 7 if funded | 2 (money decision) |
| 7 | kktoken (1 route), justdowork (1 route) (4.8) | 2 | Gateway hid the reason (401/403) | KEY / DASHBOARD after one direct call | 15 min | 0 to 2 | 3 |
| 8 | mistral Labs models (4.3a) | 2 | Labs models not enabled for the organization | DASHBOARD (privacy trade-off) | 5 min | up to 2 | 3 |
| 9 | aihubmix (4.5) | 19 | Provider-side: offline, disabled, no access | SUPPORT TICKET / WAIT | 20 min | 0 to 19, likely near 0 | 3 |
| 10 | indeedwebid (4.9) | 1 | Invalid or inactive key | KEY (replace or drop) | 10 min | up to 1 | 3 |
| 11 | seekai 12, tabiai 1, gorouter 1 (4.11) | 14 | Provider outage | WAIT | 0 min now | up to 14 when back | 3 (re-check date) |
| 12 | opencode (4.6) | 12 | Free tier restricted to the OpenCode client | SUPPORT TICKET | 15 min | 0 to 12, likely 0 | 4 |
| 13 | agentrouter (4.6) | 4 | Client allow-list ("unauthorized client") | SUPPORT TICKET | 10 min | 0 to 4, likely 0 | 4 |
| 14 | vyceai (4.6) | 1 | "Unsupported client" | SUPPORT TICKET | 5 min | 0 to 1 | 4 |
| 15 | cloudflare, seven large models (4.8) | 7 of 8 | Model needs paid billing (Workers Paid or prepaid credits) | MONEY | 10 min to confirm | up to 7 if funded | money case |
| 16 | mistral "subscription tier" (4.3b) | 6 | Model not in your plan | MONEY | 10 min to check | up to 6 if upgraded | money case |
| 17 | xkiro (4.7) | 2 | Premium/plan-gated model | MONEY | 10 min to check | up to 2 | money case |
| 18 | nararouter `agnes-video-v2.0` (4.7) | 1 | Plan does not include the model (and it is a video model) | MONEY, not worth it | 5 min | 0 (not a chat model) | stop |
| 19 | kiosapi 1, tokenrouter 1 "No available channel" (4.11) | 2 | Account group has no channel for the model | DASHBOARD or SUPPORT TICKET | 15 min | 0 to 2 | 4 |
| 20 | google Gemini (4.10) | 8 | 5 shut down, 3 limited to prior users | none | 0 min | 0 | stop, use successors |

Total routes covered: 117 of the 3,931 routes that did not answer (3.0%; the openrouter `1.3-contributor` sibling is not counted). The C cases are small in count; their value is mostly a truthful picker and a few extra working routes, not a big model gain. (Denominator: 3,931 non-answering routes among 5,794 eligible; sec 1 of REPORT.md.)

---

## 2. Before you start

**What the picker and its columns mean.** Open the picker with `m` (or `model`) then `ctrl+g` inside Claude Code. The model list shows, per route, the status of its last probe (`ok`, `auth`, `pay`, `gone`, `err`, `rate`, `t/o`, `empt`), timings, and a preview of the reply. `ctrl+o` toggles an ok-only filter. The provider list has a `status` column, then `models`, then `ok` and `free` as a count and a percent of the provider's models, then one count per status (`empt`, `auth`, `pay`, `rate`, `gone`, `t/o`, `err`). `status` reads `alive` when at least one model on that provider answered `ok`; `down` when the provider answered but nothing works (every fresh probe was a refusal for the key, the model or payment, an empty reply, a rate limit or a provider error); `dead` only when every fresh probe got no response at all (a timeout with nothing back, or a connection failure); and blank when nothing was benched. There is no `needs $` column: a provider that needs money shows its routes in the `pay` count.

**How to read `auth` versus `pay`.**
- `auth` means the provider refused the credential or the account's entitlement (HTTP 401 or 403, or a sentence saying the account is not eligible). The model exists; this account cannot use it yet.
- `pay` means the provider said money: HTTP 402, "insufficient balance", "requires a paid plan". Nothing is wrong with the key; the account needs credit or a plan.
- Some sentences changed class after the sweep: google "no longer available to new users" and orcarouter "free models are not available to this account" are now classified `auth` by the current engine (`refresh/bench.mjs`, `ACCOUNT_STATE`), but the 2026-09-29 data still records them as `gone` (google, 8) and `rate` (orcarouter, 5) because they were probed with the old rules. A re-probe records them as `auth`.

**When a fix shows up in the picker.** Two separate things, and you need both for the provider list:
1. A re-probe writes new records to `state/bench.json`. Model lists read `bench.json` live, so a re-probed route shows its new status the next time you open that model list.
2. The provider list (the `status` column, the `ok` / `free` counts and the per-status counts) and the route hints are baked into the snapshot. Rebuild it with `node menu/snapshot.mjs --build` (a `--live` re-probe does this itself when the gateway is up; do it by hand only if the sweep printed 'snapshot not rebuilt'). Until it is rebuilt, the provider list keeps showing the old figures. (Source: `menu/legend.mjs`, "every figure and row on this LIST is BAKED into the snapshot".)

**Old records.** The picker no longer hides a bench record for being old. When more than half of the records are more than 7 days old it draws a yellow "Model Status might be outdated!" line above the footer, quoting the oldest record's date and the command `node refresh/bench-cli.mjs --live`; the provider list also has an `oldest probe` column with each provider's oldest age. The records here are from 2026-09-29 10:00Z to 21:00Z (half of them older than 13:00Z), so the notice appears from about 2026-10-06T13:00Z. A default re-probe skips records younger than 7 days.

**A re-probe of `auth`, `pay` and `gone` rows needs `--force`.** In `refresh/bench-cli.mjs`, `rate`, `timeout`, `error` and `skip` results are always retried, but an `auth`, `pay`, `gone` or `ok` record younger than 7 days is treated as fresh and skipped unless you pass `--force`. Every re-verify command below for an `auth` row therefore includes `--force`. Because `--force` re-probes everything selected, the commands below select exact routes with `--only provider/id,provider/id` (ids without any `[1m]` suffix; the tool strips it) instead of a whole provider, so you never re-probe hundreds of unrelated rows.

**Cost and safety of a re-probe.** `node refresh/bench-cli.mjs ...` without `--live` is a dry run: it prints the plan and sends nothing. `--live` sends one real, tiny streamed request per selected route through your CCR gateway (`--max-tokens` defaults to 96). Defaults cap the run at about $5 total and $0.10 per row, and refused requests (401/402/404) are normally not billed. Only one sweep may run at a time (a second `--live` is refused with exit code 5). Run the dry plan first, every time.

**Nothing here restarts the gateway.** Every action in this guide is a dashboard change, a direct call, a vault key command, or a re-probe. The one exception is pushing a changed key to CCR (sambanova, indeedwebid): that is `node keysync/run.mjs --target live --i-know --no-restart`, which is built to refuse and write nothing if the change would restart the gateway. If it refuses, you decide when to restart; this guide never restarts anything.

---

## 3. Safe way to run a direct call

Some sections ask for ONE direct call outside the sweep to see the provider's real answer. The rules:

1. Never paste a key into a chat, a file, a script or a command line. Load it from the vault into a variable in your own terminal and never echo it.
2. Send exactly one request, with `max_tokens` small.
3. Print only the HTTP status and the error message. A provider can echo a masked fragment of your key in an error body (sambanova does); do not paste a full response anywhere without looking at it first.
4. Clear the variable afterwards.

Use PowerShell 7 (`pwsh`), because `-SkipHttpErrorCheck` needs it (the CCR runbook uses the same flag).

Load the key (the ids are in `plans/bench-study/providers.csv`, column `keyId`, for example `personal.cloudflare.free`):

```powershell
. C:\Users\osami\.llmkeys\ApiKeyVault.ps1
$k = Get-ApiKeyValue -Id personal.cloudflare.free     # do not print $k
```

Find the provider's base URL without touching a secret. `credential-check` prints booleans, counts and the CCR entry's `api_base_url`, never key material:

```powershell
node C:\Users\osami\.uw\keysync\credential-check.mjs kktoken
```

Send one OpenAI-style chat request (works for providers whose protocol is `openai`; set `$base` to the printed `api_base_url` and `$model` to the route id):

```powershell
$base  = "<api_base_url printed by credential-check, no trailing slash>"
$model = "<model id, for example gpt-4o-mini>"
$body  = @{ model = $model; max_tokens = 16; messages = @(@{ role = "user"; content = "Say hi." }) } | ConvertTo-Json -Depth 5
$r = Invoke-WebRequest -Uri "$base/chat/completions" -Method Post `
       -Headers @{ Authorization = "Bearer $k" } -ContentType "application/json" `
       -Body $body -SkipHttpErrorCheck
"HTTP " + [int]$r.StatusCode
$m = try { ($r.Content | ConvertFrom-Json).error.message } catch { $null }
if ($m) { $m } else { $r.Content.Substring(0, [Math]::Min(300, $r.Content.Length)) }
Remove-Variable k
```

If a provider uses a different path or protocol than `/chat/completions` (Cloudflare, section 4.8, has its own URL shape), the section says so.

How to read the status code (this table is reused by sections 4.2b, 4.8, 4.9 and 4.11):

| Direct call result | Meaning | What to do |
|---|---|---|
| 200 with text | The key and model work; the sweep failure was transient or came from the gateway | Re-probe the route; expect `ok` |
| 401 | The provider does not recognise the credential (wrong, inactive, wrong token type) | KEY: `node keysync/key.mjs test <id>`, then replace or drop |
| 402 | The credential is fine; the account has no usable credit or plan | MONEY: note it, stop here |
| 403 | The credential is fine; this account is not entitled to the model (plan, terms, region, token scope) | DASHBOARD or SUPPORT TICKET |
| 404 | The model id is not served to this account or endpoint | Check the provider's model list; likely label and stop |
| 429 | Rate limit or quota | WAIT, retry later |
| 5xx / 522 / timeout | Provider fault | WAIT, re-check in a day |

---

## 4. Provider sections

### 4.1 sambanova

**Current state.** 7 routes, all `auth`, all with the sentence "sambanova: Incorrect API key provided: [masked-key]." Example ids: `sambanova/gpt-oss-120b`, `sambanova/DeepSeek-V3.1`, `sambanova/DeepSeek-V3.2`, `sambanova/Meta-Llama-3.3-70B-Instruct`, `sambanova/gemma-4-31b-it`, `sambanova/MiniMax-M2.7`, `sambanova/MiniMax-M3`. Probed 2026-09-29 between 10:44Z and 12:47Z. The listing call to the provider returned 200 with 7 models in the same window, so the routes are listing-named. The provider is in the `dead` verdict.

**What it means.** Three facts, in order.
1. The sweep goes through CCR, which held an OLD sambanova key. SambaNova answered 401 "Incorrect API key": it did not recognise that credential at all.
2. You replaced the stored key in the vault. A direct test of the NEW key returned HTTP 402 Payment Required. A 402 is a different kind of answer: SambaNova recognised the key (identity is fine) and refused because the account has no usable credit. So 401 to 402 is progress: the key problem is solved and what remains is a money problem. This is now a MONEY case, not a key case.
3. The new key is only in the vault. CCR still holds the old key until you push it, so a re-probe today would still say "Incorrect API key". Once it is pushed AND the routes are re-probed, the 7 routes change from `auth` to `pay`, so the provider's `auth` count drops to 0 and its `pay` count reads 7 (after a snapshot rebuild, which a `--live` re-probe does itself when the gateway is up; `status` is `down` throughout, because the provider answers but nothing works, until a route reads `ok` and it turns `alive`).
SambaNova's plans page says the Free plan requires adding a payment method and purchasing credits before requests run (https://cloud.sambanova.ai/plans, checked 2026-09-29). Community threads report that billing can lag or misbehave after adding a card (https://community.sambanova.ai/t/developer-tier-free-models-not-working/1717 and https://community.sambanova.ai/t/a-payment-method-is-required-to-use-minimax-m2-7-please-set-up-a-payment-method-to-continue/1671), so a card added today may need up to about 20 minutes, per a staff reply in the second thread.

**What you need to do.**
1. (You, 5 min) Sign in to the SambaNova console at https://cloud.sambanova.ai and look at your plan and credit balance (exact menu names not verified: confirm in the provider dashboard). Decide whether you want to add credit. Adding credit is **MONEY**; if you do not want to, skip straight to step 3 and accept the `pay` state.
2. (You, 1 min) Confirm the key state: `node keysync/key.mjs test personal.sambanova.paid`. Expected today: the test reports HTTP 402 (valid key, no credit).
3. (You, 10 min, optional but makes the picker truthful) Push the new key to CCR so that, after the re-probe in step 5, the picker says `pay` instead of the misleading `bad key`:
   ```powershell
   node C:\Users\osami\.uw\keysync\run.mjs --dry
   node C:\Users\osami\.uw\keysync\run.mjs --target live --i-know --no-restart
   ```
   Read the `--dry` output first. Changing a provider's key changes the `Providers` array, and CCR restarts the gateway on a content change of `Providers` (`restartRelevantFingerprint` in `keysync/safety.mjs`), so expect `--no-restart` to REFUSE with exit code 2 ("refusing (--no-restart) ... Nothing was written and no restore point was created"). That is the safe outcome: nothing changed. It then becomes your decision when to restart, ideally when no important Claude Code session is running (`docs/CCR-Stack-Runbook.md` notes that applying has coincided with 502 incidents, and that sessions open across a restart can hold a stale key and need relaunching). Only when you accept a restart, re-run without `--no-restart`. This guide never restarts the gateway.
4. (You, 1 min) Optional check that CCR now holds the vault key: `node C:\Users\osami\.uw\keysync\credential-check.mjs sambanova` should print `EQUALS CCR KEY: true`. It prints booleans and counts only.
5. Re-verify (after the key is live in CCR, and after any credit is added):
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --only sambanova --force            # dry plan, sends nothing
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --only sambanova --force     # 7 requests; rebuilds the snapshot itself when the gateway is up
   node C:\Users\osami\.uw\menu\snapshot.mjs --build                                   # only if the sweep printed 'snapshot not rebuilt'
   ```

**How to check it worked.** After the push but before any credit: the 7 routes read `pay` (message about payment or credits), and the provider list shows `pay` 7 with `status: down`. After credit is added: the routes read `ok`, `status` turns `alive`, and the `ok` count reads 7 with 100%. Model lists update at once; the provider list after the snapshot rebuild (automatic after a `--live` re-probe with the gateway up, else `--build`).

**Expected recovery.** Up to 7 routes, only if credit is added. Even then not guaranteed: a community report says a specific model (MiniMax-M2.7) kept saying a payment method was required after adding a card. Without money: 0 routes recover, but the picker becomes accurate (7 x `pay`).

**If it does not work / when to stop.** If `key.mjs test` still reports 401 after the push, the CCR key and vault key differ: run `credential-check.mjs sambanova` and look at `EQUALS CCR KEY`. If it reports 402 after you added credit, wait 20 minutes and test again; if it is still 402 after an hour, open a ticket with SambaNova support through the console (channel not verified: confirm in the provider dashboard). If you do not want to spend money, stop after step 3; leaving the routes labelled `pay` is the correct end state.

---

### 4.2 openrouter

#### 4.2a The four `meta/muse-spark-*` routes (18+ age confirmation)

**Current state.** 4 routes `auth`: `openrouter/meta/muse-spark-1.3`, `openrouter/meta/muse-spark-1.2`, `openrouter/meta/muse-spark-1.2-contributor`, `openrouter/meta/muse-spark-1.1`. Sentence: "openrouter: This model requires you to complete the following before use: 18+ age confirmation. Confirm at [url]." (the URL is redacted in the data). A fifth route, `openrouter/meta/muse-spark-1.3-contributor`, is recorded `error: fetch failed` and has not really been tested. The same key answers 236 other openrouter routes.

**What it means.** OpenRouter gates some models behind an attestation the account owner makes once. The account is not blocked; it has not yet made the attestation. A public issue thread quotes the same error and gives the location: "Confirm at https://openrouter.ai/settings/preferences" (https://github.com/fh-eval/foxhole-forecast/issues/30; the same thread names the failing routing step as "Gate Endpoints with Attestations"). I could not find this on OpenRouter's own documentation pages, so the click path is from the error text only.

**What you need to do.**
1. (You, 3 min) Sign in to OpenRouter with the account that owns the key `personal.openrouter.free`.
2. Open https://openrouter.ai/settings/preferences (address taken from the provider's own error text) and find the 18+ confirmation control (control name not verified: confirm in the provider dashboard). This is an age attestation that you make yourself, truthfully; I cannot and should not do it for you.
3. (You, 2 min) Re-probe all five:
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --only openrouter/meta/muse-spark-1.3,openrouter/meta/muse-spark-1.2,openrouter/meta/muse-spark-1.2-contributor,openrouter/meta/muse-spark-1.1,openrouter/meta/muse-spark-1.3-contributor --force
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --only openrouter/meta/muse-spark-1.3,openrouter/meta/muse-spark-1.2,openrouter/meta/muse-spark-1.2-contributor,openrouter/meta/muse-spark-1.1,openrouter/meta/muse-spark-1.3-contributor --force
   ```
   The first command is the dry plan; run the second only if the plan lists 5 rows.

**How to check it worked.** The four routes read `ok` (a short hello preview). If a route reads `pay`, the model itself needs credit: that is a separate money case, not an age case. Expect the sibling `1.3-contributor` to read `ok` or to show the same 18+ sentence (search results indicate it has the same requirement, unverified).

**Expected recovery.** Up to 4 routes, plus 1 sibling that was never truly tested. This is the best value-for-effort item in the guide.

**If it does not work / when to stop.** If the sentence is unchanged after you confirmed, sign out and in again and retry once. If OpenRouter shows no such control on your preferences page, stop and label the routes `plan/consent required`; do not spend more than 15 minutes.

#### 4.2b The two `inkling*:free` routes (cause truncated)

**Current state.** 2 routes `auth`: `openrouter/inkling:free` and `openrouter/inkling-small:free`. Both were probed in sweep 1 (2026-09-29T10:45Z) with the old engine, so the stored sentence is only the first 40 characters ("openrouter: thinkingmachines/inkling:fre..."): the real cause was never recorded. Their paid twins `openrouter/inkling` and `openrouter/inkling-small` already answer `ok`, so the only thing at stake is the free price.

**What it means.** An HTTP 401 or 403 with a model-specific sentence on OpenRouter is usually an entitlement or consent gate (like section 4.2a), but here it is a guess. One public source states the models "are free to use inside agentic harnesses only" and that the free endpoint logs prompts and outputs and uses them to train (search result for https://openrouter.ai/thinkingmachines/inkling:free; the page fetch itself did not show those terms, so treat this as unverified).

**What you need to do.**
1. (You, 5 min) Learn the real cause with one direct call, using the safe method in section 3. Use `$model = "thinkingmachines/inkling:free"` (OpenRouter's own id for the model; the picker shows it as `inkling:free`) and the `api_base_url` printed by `node keysync\credential-check.mjs openrouter`. Read the status code and the `error.message`.
2. (You, 5 min) Open the model page https://openrouter.ai/thinkingmachines/inkling:free while signed in and read any notice about terms, consent or data policy. Also check Settings, Privacy for an option that allows free endpoints that log prompts (option name not verified: confirm in the provider dashboard).
3. If the sentence names a consent or attestation, complete it in the dashboard and re-probe:
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --only openrouter/inkling:free,openrouter/inkling-small:free --force
   ```
   (Run it without `--live` first and confirm the plan lists exactly 2 rows.)

**How to check it worked.** Both routes read `ok`.

**Expected recovery.** 0 to 2. The paid twins already work, so there is little to lose by stopping.

**If it does not work / when to stop.** If the direct call says the model is only for agentic harnesses, or requires you to accept data logging you do not want to accept, stop and label the routes `plan/consent required`. Stop after 20 minutes in any case.

---

### 4.3 mistral

#### 4.3a Two Labs models (organization opt-in)

**Current state.** 2 routes `auth`: `mistral/labs-leanstral-1-5` and `mistral/labs-leanstral-1-5-1`. Sentence: "mistral: Model labs-leanstral-1-5-1 is a Labs model. To use Labs models, an admin must enable them in your organization settings at [url]". (A third Labs row, `mistral/labs-devstral-small-2512`, is recorded `rate`, not `auth`.) The same key answers 20 other mistral routes.

**What it means.** Mistral treats "Labs" models as experimental and requires an organization admin to opt in. The two ids are Leanstral, a Lean 4 formal-proof model (https://huggingface.co/mistralai/Leanstral-1.5-119B-A6B via a search result), so they are of little use as general chat models.

**What you need to do.**
1. Decide whether you want them at all. Mistral's documentation says that if Labs models are enabled for the organization, data can be used to train Mistral models regardless of your plan or opt-out settings (https://docs.mistral.ai/admin/monitor-comply/privacy-data-controls, seen through a search result; the page returned 404 on a direct fetch, so re-read it before acting). That is a privacy trade-off you should decide on knowingly.
2. If yes, (you, 5 min) sign in as an Organization admin at https://admin.mistral.ai and open the API privacy controls (documented path "Admin Panel, API, Privacy"; the "Enable Labs models" control name and place are not verified: confirm in the provider dashboard).
3. Re-probe the two routes:
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --only mistral/labs-leanstral-1-5,mistral/labs-leanstral-1-5-1 --force
   ```
   (Dry plan first, without `--live`.)

**How to check it worked.** Both routes read `ok`, or `empty` if the model answers only after hidden reasoning (that would then be a `--max-tokens 1024` re-probe).

**Expected recovery.** Up to 2 routes.

**If it does not work / when to stop.** If you do not see the control, the setting may be restricted to a paid organization type (not verified). Stop; label `opt-in required`. My honest recommendation: skip this one, the privacy cost is larger than the value of two proof-model routes.

#### 4.3b Six "not available in your subscription tier" routes (MONEY)

**Current state.** 6 routes `auth`: `mistral/mistral-large-latest`, `mistral/mistral-large-2512`, `mistral/mistral-large-2407`, `mistral/mistral-large-2402`, `mistral/glm-5-2[1m]`, `mistral/zai-glm-5-2[1m]`. Sentence: "mistral: This model is not available in your subscription tier".

**What it means.** The key works and other mistral models answer, but these six are outside your current plan. This is a plan/upgrade question: **MONEY**. Which plan includes them is not documented in what I could read (the Mistral known-limitations page only says rate limits vary by tier and points to https://admin.mistral.ai/plateforme/limits; plan names not verified: confirm in the provider dashboard). Note that the `glm-5-2` ids are third-party models and may not be an official Mistral offering at all.

**What you need to do.** (You, 10 min) Open the limits page above and the billing page in the admin console and read what your current tier lists. If a cheaper tier lists these models, decide whether the upgrade is worth six routes. Otherwise stop.

**How to check it worked.** After any upgrade: `node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --only mistral/mistral-large-latest,mistral/mistral-large-2512,mistral/mistral-large-2407,mistral/mistral-large-2402,mistral/glm-5-2,mistral/zai-glm-5-2 --force` and expect `ok`.

**Expected recovery.** Up to 6 if upgraded; 0 otherwise. This is a money case for the later effort.

**If it does not work / when to stop.** If you are not upgrading, stop and keep the label `plan/consent required`.

---

### 4.4 alibaba (DashScope / Model Studio)

**Current state.** 17 routes `auth`, sentence "alibaba: Access denied. For details, see [url]" (6 records) or "alibaba: Access denied" (11 records). Ids: `qwen-max-2025-01-25`, `qwen-max-latest`, `qwen-turbo-2024-11-01`, `qwen-turbo-2025-04-28`, `qwen-turbo-latest`, `qwen2.5-32b-instruct`, `qwen2.5-72b-instruct`, `qwen2.5-7b-instruct`, `qwen2.5-vl-32b-instruct`, `qwen2.5-vl-72b-instruct`, `qwen2.5-vl-7b-instruct`, `qwen3-4b`, `qwen3.5-0.8b`, `qwen3.5-4b`, `qwen3.5-9b`, `qwen3.8-max-preview`, `qwen3-livetranslate-flash-realtime-2025-09-22`. Probed 2026-09-29 10:58Z to 11:35Z. The same key answers 107 other alibaba routes in the study data (112 in the later bench.json).

**What it means.** It is not a key problem: the same key works for over a hundred other routes. Alibaba's documentation (https://www.alibabacloud.com/help/en/model-studio/error-code) gives three causes for HTTP 403 "Access denied": Model Studio is not activated (ruled out here, since other routes answer), a sub-workspace API key without "Model Calling Authorization" for that model, and a workspace access problem. A fourth cause is region: "Each region has its own endpoint, API Key, and model list. These cannot be used across regions." (https://www.alibabacloud.com/help/en/model-studio/regions). Your alibaba endpoint is a workspace-specific host in the ap-southeast-1 (Singapore) region (the pinned discovery host in `refresh/discover.mjs`), so an id that is only offered in the China regions, or that is retired, will be refused. In the pricing pages I could read, none of the 17 ids appeared in the Singapore tables (https://www.alibabacloud.com/help/en/model-studio/model-pricing; the page was long and my reading may have been truncated, so treat that as a hint only). One more clue: aihubmix returns the identical sentence "Access denied. For details, see" for five of the same qwen ids (section 4.5), which points at an Alibaba-side refusal of those models rather than something specific to your account (an inference).

**What you need to do.**
1. (You, 10 min) In the Model Studio console (reached from the Alibaba Cloud documentation pages cited here), open the Singapore model list and search for each of the 17 ids. Write down which are listed and which are not (menu names not verified: confirm in the provider dashboard).
2. (You, 5 min) Check whether the API key you use belongs to the default workspace or a sub-workspace. Per https://www.alibabacloud.com/help/en/model-studio/model-calling-in-sub-workspace, a sub-workspace key needs the main account's administrator to grant model calling authorization for each model; the default workspace key can call all models. If yours is a sub-workspace key and the models are listed, ask the administrator to grant them (location in the console not verified: confirm in the provider dashboard).
3. (You, 5 min) Re-probe the 17 routes only if step 1 showed some are listed or step 2 changed something:
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only alibaba/qwen-max-2025-01-25,alibaba/qwen-max-latest,alibaba/qwen-turbo-2024-11-01,alibaba/qwen-turbo-2025-04-28,alibaba/qwen-turbo-latest,alibaba/qwen2.5-32b-instruct,alibaba/qwen2.5-72b-instruct,alibaba/qwen2.5-7b-instruct,alibaba/qwen2.5-vl-32b-instruct,alibaba/qwen2.5-vl-72b-instruct,alibaba/qwen2.5-vl-7b-instruct,alibaba/qwen3-4b,alibaba/qwen3.5-0.8b,alibaba/qwen3.5-4b,alibaba/qwen3.5-9b,alibaba/qwen3.8-max-preview,alibaba/qwen3-livetranslate-flash-realtime-2025-09-22
   ```
   Run it once without `--live` first to see the plan (17 rows).

**How to check it worked.** Routes that were granted or listed read `ok`; the rest keep the same `Access denied` sentence.

**Expected recovery.** Upper bound 17. Realistically only the ids the Singapore list actually offers can come back, and the older `-latest` and Qwen2.5 aliases and the `qwen3.5-0.8b` family are the most likely to be absent (an inference from the pricing page, not verified).

**If it does not work / when to stop.** If the console does not list an id in your region, stop for that id: it will never answer on this endpoint, and the picker label `access denied` is correct. Do not create a China-region account to chase them (out of scope; different key, different endpoint, and an identity verification for mainland access per the docs). Stop after 30 minutes.

---

### 4.5 aihubmix

**Current state.** 19 routes `auth`, all provider-side sentences. The same key answers 272 other aihubmix routes (297 in the later bench.json). Breakdown by sentence, with the ids:

| Sentence (redacted) | Routes | Ids |
|---|---|---|
| "The model is offline (tid: [tid])" | 5 | `kimi-k2-0711`, `kimi-k2-instruct`, `ernie-5.0-thinking-exp`, `ernie-4.5-turbo-latest`, `ernie-4.5-turbo-vl` |
| "The model does not exist or you do not have access to it. (tid: [tid])" | 5 | `DeepSeek-V3.1-Think`, `ernie-4.5`, `ernie-4.5-0.3b`, `ernie-4.5-turbo-128k-preview`, `ernie-x1-turbo` |
| "Model access denied. (tid: [tid])" | 1 | `qwen3-max-2026-01-23` |
| "Access denied. For details, see: [url] (tid: [tid])" | 5 | `qwen-turbo-latest`, `qwen3-4b`, `qwen3-0.6b`, `qwen-turbo-2025-04-28`, `qwen-turbo-2024-11-01` |
| "Model disabled. (tid: [tid])" | 3 | `cc-ernie-4.5-300b-a47b`, `cc-kimi-k2-instruct`, `cc-kimi-k2-instruct-0905` |

(The five plus one "does not exist or model access denied" rows are the "6" of the study's grouping.) All 19 were probed 2026-09-29 between 11:40Z and 13:52Z.

**What it means.** aihubmix is a reseller: it uses 401/403 for models that are offline, disabled, or that your group cannot use. That is provider-side. Nothing in your key or account settings is documented as controlling it.

**What you need to do.**
1. (You, 10 min) Check whether the models are still in service. AiHubMix documents a Models API, `GET https://aihubmix.com/api/v1/models`, with a `retire_stage` field (`active` or `deprecated`) and says models no longer in service are excluded (https://docs.aihubmix.com/en/api/Models-API; the docs suggest it can be called without credentials, not verified). An id absent from that list is retired: stop for that id.
2. (You, 10 min) For an id that IS listed as `active` but your route says offline or disabled, open a support ticket. AiHubMix's FAQ gives online customer service and feedback@aihubmix.com (https://docs.aihubmix.com/en/FAQs/Faq). In the ticket give the model id and the exact time of a fresh direct call plus its `[tid]` request id (take the tid from a NEW direct call, section 3, not from the old sweep).
3. Re-probe monthly, not now.

**How to check it worked.** `node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only aihubmix/kimi-k2-0711,aihubmix/kimi-k2-instruct,aihubmix/ernie-5.0-thinking-exp,aihubmix/ernie-4.5-turbo-latest,aihubmix/ernie-4.5-turbo-vl,aihubmix/DeepSeek-V3.1-Think,aihubmix/ernie-4.5,aihubmix/ernie-4.5-0.3b,aihubmix/ernie-4.5-turbo-128k-preview,aihubmix/ernie-x1-turbo,aihubmix/qwen3-max-2026-01-23,aihubmix/qwen-turbo-latest,aihubmix/qwen3-4b,aihubmix/qwen3-0.6b,aihubmix/qwen-turbo-2025-04-28,aihubmix/qwen-turbo-2024-11-01,aihubmix/cc-ernie-4.5-300b-a47b,aihubmix/cc-kimi-k2-instruct,aihubmix/cc-kimi-k2-instruct-0905` (dry plan first: 19 rows). Expect `ok` only for models the provider put back.

**Expected recovery.** Upper bound 19; realistically close to 0. "Offline" and "Model disabled" are provider decisions, the five `Access denied` qwen ids mirror the alibaba refusals (section 4.4), and the ERNIE and Kimi ids look retired.

**If it does not work / when to stop.** After one ticket and one monthly re-check, stop. Keep the label `no access/offline`.

---

### 4.6 opencode, agentrouter, vyceai (client restrictions)

#### opencode (12 routes)

**Current state.** 12 routes `auth`, sentence "opencode: OpenCode's free tier can only be used from within OpenCode". Ids: `big-pickle`, `mimo-v2.5-free`, `muse-spark-1.2-contributor-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `ling-3.0-flash-fin-free`, `mimo-v2.6-flash-free`, `muse-spark-1.3-contributor-free`, `jev-1.13-free`, `test`, `test-novita-dsf4.1`, `longcat-2.5-preview-free`. The same key answers 3 opencode routes: `space-bunny-free` (a free model), `claude-opus-5` and `claude-opus-5-5`. A further 57 opencode routes are `pay` (money, separate).

**What it means.** OpenCode refuses these free models when the request does not come from its own client. Two facts pull in different directions: OpenCode's Zen documentation says free models are reachable through the API with a key (https://opencode.ai/docs/zen/), and yet one free model on your key answers. A public issue shows the same sentence for requests sent with the anonymous "public" key that some tools fill in for free models (https://github.com/ahmadrosid/nakama/issues/1049). Whether your vault key is a personal account key or an anonymous one I cannot tell (I did not read the vault).

**What you need to do.**
1. (You, 10 min) In the OpenCode Zen console check that the key you use was created in your own account (the docs' flow is: sign in to OpenCode Zen, add billing details, copy your API key). Adding billing details is a pay-as-you-go arrangement and the documentation notes an auto-reload of $20 when the balance falls below $5, so treat that as **MONEY** and do not enable auto-reload casually.
2. (You, 5 min) If the key is already your own, contact OpenCode support through the channel in their docs or Discord (channel not verified: confirm in the provider dashboard) and ask whether free models are available to third-party clients with a personal key.
3. If anything changed, re-probe: `node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only opencode/big-pickle,opencode/mimo-v2.5-free,opencode/muse-spark-1.2-contributor-free,opencode/nemotron-3-ultra-free,opencode/nemotron-3.5-lightning-free,opencode/ling-3.0-flash-fin-free,opencode/mimo-v2.6-flash-free,opencode/muse-spark-1.3-contributor-free,opencode/jev-1.13-free,opencode/test,opencode/test-novita-dsf4.1,opencode/longcat-2.5-preview-free` (dry plan first: 12 rows).

**How to check it worked.** The routes read `ok`. **Expected recovery.** 0 to 12; my honest estimate is 0, because the sentence describes a policy, not account state. **If it does not work / when to stop.** If support confirms the free tier is client-only, label `restricted client` and stop. Two of the twelve ids (`test`, `test-novita-dsf4.1`) look like internal test models and are not worth chasing at all.

#### agentrouter (4 routes)

**Current state.** 4 routes `auth`: `agentrouter/gpt-5.6-sol`, `agentrouter/claude-opus-4-8[1m]`, `agentrouter/deepseek-v4-flash`, `agentrouter/gpt-6-astra`. Sentence: "agentrouter: unauthorized client detected, contact support for assistance at [url]". One route answers `ok` on the same key: `agentrouter/claude-opus-5[1m]`.

**What it means.** AgentRouter accepts requests only from approved coding clients. A public issue lists an allow-list (Claude Code, Codex, Gemini CLI, RooCode, Kilocode, Qwen Code, Droid CLI) and says another open-source client was rejected with this same message (https://github.com/agentrouter-org/docs/issues/21). That the claude-opus-5 route answers while others are refused suggests the check depends on the shape of the request and the model (an inference; one blog post reports the same idea, not verified).

**What you need to do.** (You, 10 min) Use the support link in the error (the message contains one; it is redacted in the data, and the public sources point to a Discord server) and ask which client or headers are approved for a personal key going through a gateway. Nothing else in this guide can help.

**How to check it worked.** Re-probe the four routes: `node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only agentrouter/gpt-5.6-sol,agentrouter/claude-opus-4-8,agentrouter/deepseek-v4-flash,agentrouter/gpt-6-astra` (dry plan first, 4 rows). **Expected recovery.** 0 to 4; likely 0. **If it does not work / when to stop.** If support does not answer within a week or says third-party gateways are not allowed, label `restricted client` and stop.

#### vyceai (1 route)

**Current state.** 1 route `auth`: `vyceai/qwen3.8-flash`, sentence "vyceai: Unsupported client." Six other vyceai routes answer `ok` on the same key (for example `vyceai/gpt-6-luna`, `vyceai/claude-sonnet-4-6`).

**What it means.** This one model is rejected for the client it sees. I found no public documentation of this message for vyceai.

**What you need to do.** (You, 5 min) Look at the model in the vyceai dashboard or docs for a client note (not verified: confirm in the provider dashboard) and, if you care about this single model, ask support. Otherwise stop.

**How to check it worked.** `node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only vyceai/qwen3.8-flash`. **Expected recovery.** 0 to 1. **If it does not work / when to stop.** Immediately after one support message; label `restricted client`.

---

### 4.7 xkiro and nararouter (plan or entitlement)

#### xkiro (2 routes)

**Current state.** 2 routes `auth`: `xkiro/anthropic/claude-fable-5-1` and `xkiro/openai/gpt-6-astra`. Example sentence: "xkiro: openai/gpt-6-astra is currently available on the Ultra and Power plans, or with pay-as-you-go credit. Demand for this model is exceptionally high right n[ow]". The same key answers 53 xkiro routes, and 71 other xkiro routes are `pay` (a separate money case: "premium model requires an active paid plan or real deposited balance").

**What it means.** xkiro documents three model tiers: Free, Paid ("an active paid plan or a positive wallet balance"), and Premium ("Available once the account has made a real payment; gifts and trials do not unlock this tier") (https://docs.xkiro.com/guides/pricing/). These two are gated to higher plans or a real deposit. That is **MONEY**.

**What you need to do.** (You, 10 min) Open https://xkiro.com/dashboard and check your plan and wallet, separating deposited funds from promotional credit (page names not verified: confirm in the provider dashboard). If you never plan to deposit real money, stop.

**How to check it worked.** After a deposit or plan change: `node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only xkiro/anthropic/claude-fable-5-1,xkiro/openai/gpt-6-astra`. **Expected recovery.** Up to 2 (and the 71 `pay` routes are the bigger question for the money effort). **If it does not work / when to stop.** If a deposit does not unlock them, note the response and stop; the label `plan/consent required` is accurate.

#### nararouter (1 route)

**Current state.** 1 route `auth`: `nararouter/agnes-video-v2.0`, sentence "nararouter: Your plan does not include the requested model." The same key answers 10 nararouter routes (for example `agnes-2.5-flash`, `agnes-3-flash`).

**What it means.** NaraRouter's documentation says this sentence is returned as HTTP 403 when "your plan does not include the requested model, or the account is suspended", and that the live `/v1/models` list shows which aliases your plan entitles you to (https://router.bynara.id/docs). `agnes-video-v2.0` is documented there as a reference-to-video model, so it is a non-chat model: a chat probe would be meaningless even with the right plan.

**What you need to do.** Nothing. (Optional, 5 min: check `/pricing` on the provider's site; a plan upgrade would be **MONEY** and would not give you a chat model.) Recommendation: hide or label this route as non-chat.

**How to check it worked.** Not applicable. **Expected recovery.** 0 chat routes. **If it does not work / when to stop.** Now.

---

### 4.8 cloudflare, kktoken, justdowork (the gateway hid the reason)

#### cloudflare (8 routes)

**Current state.** 8 routes `auth` with the sentence "cloudflare: Upstream request failed." (the gateway replaced the provider's own words): `@cf/moonshotai/kimi-k2.7-code`, `@cf/moonshotai/kimi-k2.6`, `@cf/zai-org/glm-5.3[1m]`, `@cf/zai-org/glm-5.3-flash`, `@cf/zai-org/glm-5.2[1m]`, `@cf/deepseek-ai/deepseek-v4-flash-0731[1m]`, `@cf/deepseek-ai/deepseek-v4-pro-0813[1m]`, `@cf/meta/llama-3.2-11b-vision-instruct`. The same key answers 17 other cloudflare routes (`ok`), so the key works.

**What it means.** Cloudflare's own pricing page explains seven of the eight: "Some models require a paid billing method. This applies to `@cf/moonshotai/kimi-k2.6`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.2`, `@cf/zai-org/glm-5.3`, `@cf/zai-org/glm-5.3-flash`, `@cf/deepseek-ai/deepseek-v4-flash-0731`, and `@cf/deepseek-ai/deepseek-v4-pro-0813`", reachable through the Workers Paid plan or prepaid AI Gateway credits (https://developers.cloudflare.com/workers-ai/platform/pricing/; the Kimi K2.6 page repeats that it is not available through standard Workers Free billing, https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/). Those seven are therefore a **MONEY** case, whatever the gateway's opaque text says. The eighth, `@cf/meta/llama-3.2-11b-vision-instruct`, is a licence case: Cloudflare's tutorial says you must first accept Meta's license and acceptable-use policy by sending one request with `"prompt": "agree"` to that model (https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/). Community reports name the unaccepted-license failure as error code 5016 (not verified in Cloudflare's own documentation).

**What you need to do.**
1. (You, 10 min) The safe direct call for the license, one request only. You need your Cloudflare account id (not a secret; shown in the Cloudflare dashboard, location not verified: confirm in the provider dashboard). The Workers AI REST shape is documented at https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/:
   ```powershell
   . C:\Users\osami\.llmkeys\ApiKeyVault.ps1
   $k    = Get-ApiKeyValue -Id personal.cloudflare.free          # never printed
   $acct = Read-Host "Cloudflare account id"
   $r = Invoke-WebRequest -Method Post `
         -Uri "https://api.cloudflare.com/client/v4/accounts/$acct/ai/run/@cf/meta/llama-3.2-11b-vision-instruct" `
         -Headers @{ Authorization = "Bearer $k" } -ContentType "application/json" `
         -Body '{ "prompt": "agree" }' -SkipHttpErrorCheck
   "HTTP " + [int]$r.StatusCode
   $r.Content.Substring(0, [Math]::Min(300, $r.Content.Length))
   Remove-Variable k
   ```
   By accepting, you accept Meta's license on your own behalf; read it first (linked from the model page). Expected: HTTP 200.
2. (You, 5 min) To see the true reason for one of the seven paid-billing models, make one OpenAI-style call to `https://api.cloudflare.com/client/v4/accounts/$acct/ai/v1/chat/completions` (documented base URL `.../ai/v1`, bearer token, https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) using the pattern in section 3 with `model = "@cf/moonshotai/kimi-k2.6"`. What each answer means: 401 the token is invalid or lacks Workers AI permission (the same token answers 17 other models, so unlikely); 403 or a billing sentence means the paid-billing gate; 200 means the earlier failure was transient. The exact text Cloudflare returns for a paid-only model was not found in documentation.
3. (You) Decide on the seven: **MONEY** (Workers Paid plan or prepaid AI Gateway credit). If you do not want to pay, stop.
4. Re-probe:
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only cloudflare/@cf/meta/llama-3.2-11b-vision-instruct
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only cloudflare/@cf/moonshotai/kimi-k2.7-code,cloudflare/@cf/moonshotai/kimi-k2.6,cloudflare/@cf/zai-org/glm-5.3,cloudflare/@cf/zai-org/glm-5.3-flash,cloudflare/@cf/zai-org/glm-5.2,cloudflare/@cf/deepseek-ai/deepseek-v4-flash-0731,cloudflare/@cf/deepseek-ai/deepseek-v4-pro-0813
   ```
   (Dry plan for each first.)

**How to check it worked.** The vision route reads `ok`. The seven read `ok` only after paid billing exists.

**Expected recovery.** 1 route without paying; up to 7 more with money. Without money: 1 of 8.

**If it does not work / when to stop.** If the license call returns something other than 200, stop after one retry and keep the label `auth? (opaque)`. If you are not paying, the seven stay `auth`.

#### kktoken (1 route) and justdowork (1 route)

**Current state.** `kktoken/gpt-4o-mini` (sentence "kktoken: Upstream request failed.") and `justdowork/claude-opus-4-8` (sentence "justdowork: Upstream request failed."), each the only route of its provider, each `auth` (HTTP 401 or 403) with the reason hidden by the gateway, both probed 2026-09-29T10:44Z. Both providers read `down` (an `auth` answer is a response, but nothing works), each with its one route in the `auth` count.

**What it means.** Unknown. No public documentation of these providers was found. It could be an invalid key, an inactive account, or a model not enabled.

**What you need to do.**
1. (You, 5 min) Test the credential: `node C:\Users\osami\.uw\keysync\key.mjs test personal.kktoken.free` and `node C:\Users\osami\.uw\keysync\key.mjs test personal.justdowork.free`.
2. (You, 10 min) Make ONE direct call per provider with the method in section 3 (get `$base` with `credential-check.mjs kktoken` or `justdowork`), using `model = "gpt-4o-mini"` for kktoken and `model = "claude-opus-4-8"` for justdowork. Apply the status-code table in section 3.
3. If 401: replace or drop the key (section 4.9 shows both). If 403: log in to the provider's dashboard and check the plan and enabled models (not verified: confirm in the provider dashboard). If 200: re-probe.
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only kktoken/gpt-4o-mini,justdowork/claude-opus-4-8
   ```

**How to check it worked.** The route reads `ok` and the provider shows `status: alive` with `ok` 1 and 100% once the snapshot is rebuilt (a `--live` re-probe does this itself when the gateway is up; do it by hand only if the sweep printed 'snapshot not rebuilt').

**Expected recovery.** 0 to 2.

**If it does not work / when to stop.** If the direct call also says 401 and a fresh key fails too, drop the provider. One provider route is rarely worth an hour.

---

### 4.9 indeedwebid (1 route)

**Current state.** 1 route `auth`: `indeedwebid/ineed/freetier`, sentence "indeedwebid: Invalid or inactive API key". Its discovery call also returned 401 (providers.csv). Host is `ineed.web.id`. The provider reads `down` with `auth` 1.

**What it means.** A key or account problem, and the only remaining clear key problem in the whole `auth` set now that sambanova has turned out to be a money case. I found no public documentation for this provider.

**What you need to do.**
1. (You, 2 min) `node C:\Users\osami\.uw\keysync\key.mjs test personal.indeedwebid.free`. If it reports 401 too, the key is dead.
2. (You, 10 min) Either replace the key or drop the provider.
   - Replace: get a fresh key in the provider's dashboard (not verified: confirm in the provider dashboard), then remove and add:
     ```powershell
     node C:\Users\osami\.uw\keysync\key.mjs remove personal.indeedwebid.free
     node C:\Users\osami\.uw\keysync\key.mjs add personal indeedwebid free --notes "replaced 2026-09-29"
     node C:\Users\osami\.uw\keysync\key.mjs test personal.indeedwebid.free
     ```
     `add` prompts for the secret on your real terminal, test-calls it, and tells you if the vault is now ambiguous (then it asks you to pick the key CCR routes on). Then push it: `node C:\Users\osami\.uw\keysync\run.mjs --dry`, then `node C:\Users\osami\.uw\keysync\run.mjs --target live --i-know --no-restart` (it will probably refuse for the same reason as in section 4.1; your decision then).
   - Drop: `node C:\Users\osami\.uw\keysync\key.mjs remove personal.indeedwebid.free`, then `node C:\Users\osami\.uw\keysync\run.mjs --dry` and read what it says will change, then apply with `--target live --i-know` when a restart is acceptable, then `node C:\Users\osami\.uw\menu\snapshot.mjs --build`. The vault removal alone does not change what CCR is running until the apply.

**How to check it worked.** Replace: `key.mjs test` succeeds, then `node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only indeedwebid/ineed/freetier` reads `ok`. Drop: the provider is gone from the picker's provider list after the snapshot rebuild (confirm with `--dry` before applying; I have not verified that removal drops the provider row).

**Expected recovery.** Up to 1 route.

**If it does not work / when to stop.** If the provider will not issue a key or the fresh key is also refused, drop it. One route does not justify more than 15 minutes.

---

### 4.10 google Gemini (8 routes) and orcarouter (5 routes)

#### google Gemini

**Current state.** 8 routes recorded `gone` by the old rules, sentence "google: This model models/gemini-2.0-fla..." (truncated to 40 characters in the sweep-1 records; all legacy): `gemini-2.0-flash[1m]`, `gemini-2.0-flash-001[1m]`, `gemini-2.0-flash-lite[1m]`, `gemini-2.0-flash-lite-001[1m]`, `gemini-2.5-flash[1m]`, `gemini-2.5-flash-lite[1m]`, `gemini-2.5-pro[1m]`, `gemini-3-pro-preview[1m]`. The current engine classifies the "no longer available to new users" sentence as `auth`, so a re-probe would record them as `auth`.

**What it means.** Google's deprecation page (https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-09-29) says something different for two groups:
- Shut down for everyone: `gemini-2.0-flash` and `gemini-2.0-flash-001` (shutdown 2026-06-01, recommended replacement `gemini-3.6-flash`); `gemini-2.0-flash-lite` (2026-06-01, `gemini-3.1-flash-lite`); `gemini-3-pro-preview` (2026-03-09, `gemini-3.1-pro-preview`). `gemini-2.0-flash-lite-001` was not listed separately on the page I read; it is presumably the same. That is 5 of the 8.
- `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro` (3 of 8): "not deprecated", but "we are limiting access to the 2.5 models to users who have actively used them in the past". Your account or project is not on that list. You cannot become a past user retroactively.

So there is nothing to fix on your side. The useful thing is that successors already work or can be tested: `google/gemini-3.1-flash-lite`, `gemini-3.5-flash-lite` and `gemini-3.8-flash` answer `ok` now; `gemini-3.6-flash` is recorded `error` (worth a re-probe) and `gemini-3.1-pro-preview` is `rate` (a quota).

**What you need to do.** (You, 5 min, optional) Re-probe the two successors that are not `ok` and leave the eight retired or restricted routes alone:
```powershell
node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --only google/gemini-3.6-flash,google/gemini-3.1-pro-preview --force
```

**How to check it worked.** `gemini-3.6-flash` reads `ok`; `gemini-3.1-pro-preview` reads `ok` or `quota exhausted`.

**Expected recovery.** 0 of the 8; possibly +1 or +2 successor routes.

**If it does not work / when to stop.** Stop now for the 8. The study labels all eight `restricted (new users)`; per Google's page five of them are really shut down, which is a label-text question for the picker work and out of scope here.

#### orcarouter (5 routes)

**Current state.** 5 routes recorded `rate` by the old rules, sentence "orcarouter: Free models are not available to this account yet. They require the workspace owner to link a GitHub account that has been registered for some time ...": `orcarouter/free`, `orcarouter/deepseek/deepseek-v4-flash-free`, `orcarouter/tencent/hy3-free`, `orcarouter/tencent/hy4-preview-free`, `orcarouter/z-ai/glm-5.3-flash-free`. A re-probe with the current engine records them as `auth`. The other 160 orcarouter routes are `pay` (money, separate); only 2 answer `ok` (`anthropic/claude-opus-5`, `anthropic/claude-opus-5.5`).

**What it means.** Not a rate limit. OrcaRouter's free models require an "established" account: the workspace owner links a GitHub account with some history, or the workspace makes a paid purchase of any amount; the error code is `err_free_access_denied` (https://docs.orcarouter.ai/routing/free-models, checked 2026-09-29). The free route is DASHBOARD (free); the paid route would be **MONEY**.

**What you need to do.**
1. (You, 10 min) Sign in to the OrcaRouter console (the billing page is https://www.orcarouter.ai/console/billing per `docs/CCR-Stack-Runbook.md`) and link a GitHub account in the workspace owner's profile settings, or sign in with GitHub (exact menu location not verified: confirm in the provider dashboard). The GitHub account should be an established one you own.
2. Re-probe:
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only orcarouter/orcarouter/free,orcarouter/deepseek/deepseek-v4-flash-free,orcarouter/tencent/hy3-free,orcarouter/tencent/hy4-preview-free,orcarouter/z-ai/glm-5.3-flash-free
   ```
   (Dry plan first: 5 rows. If it reports "matches no probeable row", run `node C:\Users\osami\.uw\refresh\bench-cli.mjs --only orcarouter` to see the exact route ids.)

**How to check it worked.** The five read `ok` or, if the free allowance limits bite, `rate` (a per-minute or per-day cap, or a prompt-size cap that returns HTTP 400; documented on the same page).

**Expected recovery.** Up to 5 routes.

**If it does not work / when to stop.** If the GitHub link is rejected as "not established enough", the only remaining route is a purchase (MONEY); stop.

---

### 4.11 Outages and channel-group cases (no owner action beyond a re-check date)

**Current state.**

| Provider | Routes | Recorded state and sentence | Probed |
|---|---|---|---|
| seekai (host `seekai.cc`) | 12 | `error` for all 12: 11 x "seekai: system disk overloaded (current: 99.1%, threshold: 95%)" and 1 `fetch failed` | 2026-09-29 12:52Z to 13:00Z |
| tabiai (host `tabitoken.com`) | 1 (`claude-opus-4-8`) | `error`, "Upstream request failed."; discovery HTTP 522 | 2026-09-29 12:46Z |
| gorouter (host `gorouter.app`) | 1 (`claude-opus-4-8`) | `error`, "Upstream request failed."; discovery HTTP 502 | 2026-09-29 12:45Z |
| kiosapi | 1 (`deepseek-v4.1-flash-free`) | `gone`, "kiosapi: No available channel for model deepseek-v4.1-flash-free under group default (distributor) (request id: [id])" | 2026-09-29 12:44Z |
| tokenrouter | 1 (`qwen/qwen3.8-max-free`) | `gone`, same "No available channel ... under group default (distributor)" sentence | 2026-09-29 14:24Z |

**What it means.** seekai, tabiai and gorouter are provider outages (a full disk, an HTTP 522, an HTTP 502): they need no action from you, only a re-check. kiosapi and tokenrouter are NOT outages, although the study groups kiosapi with the dead providers: "No available channel for model X under group Y" is the pattern of a routing gateway saying the API token's group has no upstream channel for that model, i.e. an account-group entitlement. I found only a bug report showing this sentence in the open-source "new-api" gateway software, not provider documentation, so the cause is not verified.

**What you need to do.**
1. seekai, tabiai, gorouter: (nothing now.) Re-probe on or after 2026-10-01 (give them at least a day; an errored route is retried automatically, so no `--force` is needed):
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --only seekai,tabiai,gorouter
   ```
   That is 14 requests. Run the dry plan first.
2. kiosapi and tokenrouter: (You, 15 min, optional) In each provider's dashboard look at the API token's "group" and whether that group lists the model (setting name not verified: confirm in the provider dashboard); if the group is wrong, change it there or ask support. For tokenrouter, the model name `qwen/qwen3.8-max-free` is a free model and tokenrouter's 130 `pay` routes say your gift balance cannot cover models (money case), so this may be part of the same plan gate.
   ```powershell
   node C:\Users\osami\.uw\refresh\bench-cli.mjs --live --force --only kiosapi/deepseek-v4.1-flash-free,tokenrouter/qwen/qwen3.8-max-free
   ```

**How to check it worked.** seekai, tabiai, gorouter: the routes read `ok` (and `status` turns `alive` and the provider's `ok` count rises once the snapshot is rebuilt (a `--live` re-probe does this itself when the gateway is up; do it by hand only if the sweep printed 'snapshot not rebuilt')). kiosapi and tokenrouter: `ok`.

**Expected recovery.** seekai up to 12, tabiai and gorouter up to 1 each, when the provider is back; they may also stay down. kiosapi and tokenrouter up to 1 each.

**If it does not work / when to stop.** If seekai is still overloaded on a re-check a week later, label it and re-check monthly, and consider dropping it (see section 4.9 for how). If tabiai and gorouter still 5xx after two re-checks, stop; each is one route. Nothing in UW re-probes on a timer, so put the re-check date in the tracking table below.

---

## 5. Re-probe and refresh checklist

One provider at a time, in this order. Before any `--live`, run the same command without `--live` and check the plan says the number of rows you expect. Only one sweep at a time.

1. **Dry plan** (sends nothing): the command with the exact `--only` list from the provider's section, plus `--force` for `auth`, `pay` and `gone` rows.
2. **Live re-probe:** the same command with `--live`. Read the summary line; a run that gives exit code 3 means requests were sent and nothing answered `ok`; exit code 4 means the gateway went down (re-run later).
3. **Rebuild the snapshot, only if the sweep did not:** a `--live` re-probe rebuilds it itself when the gateway is up and the run recorded something; if it printed 'snapshot not rebuilt' (or you used `--reclassify-notices`, `--redact` or `--compact`), run `node C:\Users\osami\.uw\menu\snapshot.mjs --build`. Needed for the provider-list columns (`status`, `ok` / `free`, the per-status counts) and route hints.
4. **Verify in the picker:** open the picker (`m`, then `ctrl+g`). On the provider list, check the `status` column and the `ok` and per-status counts (`auth`, `pay`, ...) for that provider. Open the provider, press `ctrl+o` for the ok-only filter, and confirm the recovered routes appear.

Per-provider re-probe commands are in each section. Quick reference (dry plans first):

| Provider | Command (after the fix) |
|---|---|
| sambanova | `node refresh/bench-cli.mjs --live --only sambanova --force` |
| openrouter (muse) | `node refresh/bench-cli.mjs --live --force --only openrouter/meta/muse-spark-1.3,openrouter/meta/muse-spark-1.2,openrouter/meta/muse-spark-1.2-contributor,openrouter/meta/muse-spark-1.1,openrouter/meta/muse-spark-1.3-contributor` |
| openrouter (inkling) | `node refresh/bench-cli.mjs --live --force --only openrouter/inkling:free,openrouter/inkling-small:free` |
| orcarouter | section 4.10 |
| cloudflare | section 4.8 |
| mistral | section 4.3 |
| alibaba | section 4.4 (17 ids) |
| aihubmix | section 4.5 (19 ids), monthly |
| opencode / agentrouter / vyceai | sections 4.6 |
| xkiro | `node refresh/bench-cli.mjs --live --force --only xkiro/anthropic/claude-fable-5-1,xkiro/openai/gpt-6-astra` |
| seekai, tabiai, gorouter | `node refresh/bench-cli.mjs --live --only seekai,tabiai,gorouter` (no `--force` needed), on or after 2026-10-01 |
| kiosapi, tokenrouter | section 4.11 |
| indeedwebid, kktoken, justdowork | sections 4.8 and 4.9 |

All commands are run from `C:\Users\osami\.uw`. The flags used in this guide were confirmed in `refresh/bench-cli.mjs` (`--live`, `--only`, `--only-file`, `--force`, `--max-tokens`, `--timeout`, `--max-row-cost`, `--redact` all exist) and the key commands in `keysync/key.mjs` (`add`, `remove`, `list`, `test`, `prefer`) and `keysync/run.mjs` (`--dry`, `--target live`, `--i-know`, `--no-restart`).

Date to remember: from about 2026-10-06T13:00Z the picker shows the yellow outdated line (more than half of the records are then more than 7 days old). The `auth` and `pay` labels stay visible; a re-sweep refreshes them and clears the line.

---

## 6. Tracking

Tick each box as you go. "Done" is the account action or decision. Dates are yours to fill in.

| Provider | Routes | Action type | Done (action taken) | Direct call made | Re-probed | Snapshot rebuilt | Result (routes now ok) | Date |
|---|---|---|---|---|---|---|---|---|
| openrouter muse-spark | 4 (+1) | DASHBOARD | [ ] | n/a | [ ] | [ ] |  |  |
| orcarouter free models | 5 | DASHBOARD | [ ] | n/a | [ ] | [ ] |  |  |
| cloudflare llama-3.2-11b-vision | 1 | license call | [ ] | [ ] | [ ] | [ ] |  |  |
| openrouter inkling free | 2 | DASHBOARD | [ ] | [ ] | [ ] | [ ] |  |  |
| alibaba | 17 | DASHBOARD | [ ] | n/a | [ ] | [ ] |  |  |
| sambanova | 7 | MONEY / KEY push | [ ] | [ ] | [ ] | [ ] |  |  |
| kktoken | 1 | KEY | [ ] | [ ] | [ ] | [ ] |  |  |
| justdowork | 1 | KEY | [ ] | [ ] | [ ] | [ ] |  |  |
| mistral Labs | 2 | DASHBOARD | [ ] | n/a | [ ] | [ ] |  |  |
| aihubmix | 19 | SUPPORT TICKET | [ ] | [ ] | [ ] (monthly) | [ ] |  |  |
| indeedwebid | 1 | KEY | [ ] | [ ] | [ ] | [ ] |  |  |
| seekai / tabiai / gorouter | 14 | WAIT (from 2026-10-01) | [ ] | n/a | [ ] | [ ] |  |  |
| opencode | 12 | SUPPORT TICKET | [ ] | n/a | [ ] | [ ] |  |  |
| agentrouter | 4 | SUPPORT TICKET | [ ] | n/a | [ ] | [ ] |  |  |
| vyceai | 1 | SUPPORT TICKET | [ ] | n/a | [ ] | [ ] |  |  |
| kiosapi / tokenrouter | 2 | DASHBOARD | [ ] | n/a | [ ] | [ ] |  |  |
| google Gemini (successors) | 8 (0 fixable) | none | [ ] | n/a | [ ] | [ ] |  |  |
| cloudflare seven large models | 7 | MONEY | [ ] | [ ] | [ ] | [ ] |  |  |
| mistral subscription tier | 6 | MONEY | [ ] | n/a | [ ] | [ ] |  |  |
| xkiro | 2 | MONEY | [ ] | n/a | [ ] | [ ] |  |  |
| nararouter agnes-video | 1 | stop | [ ] | n/a | n/a | n/a |  |  |

---

## 7. What is out of scope here

- Money top-ups and plan purchases. The MONEY items above say what to check and where to stop; deciding to pay, and the ranking of which provider to fund, belongs to the separate money effort (`plans/bench-study/REPORT.md` sec 4e ranks pay providers by listing-named routes).
- Gateway restarts. Nothing here restarts CCR. If a key push (`--no-restart`) refuses because a restart is needed, choosing the moment to restart is yours.
- Routing, alias and label work (label texts, hiding non-chat ids, removal candidates, the 361 remove candidates, `aliasOf` hints). Those are picker decisions covered by REPORT.md sec 5.
- The 1,972 `pay` routes, the `fetch failed` re-probe set, the `empty` rows that need `--max-tokens 1024`, and gone/error cases that are not account state.
- Creating accounts in other regions (for example a China-region Alibaba account).

---

## Appendix: sources used

Public pages I checked (2026-09-29):
- SambaNova plans: https://cloud.sambanova.ai/plans; community threads https://community.sambanova.ai/t/developer-tier-free-models-not-working/1717 and https://community.sambanova.ai/t/a-payment-method-is-required-to-use-minimax-m2-7-please-set-up-a-payment-method-to-continue/1671
- OpenRouter 18+ error text (issue thread): https://github.com/fh-eval/foxhole-forecast/issues/30 ; OpenRouter model pages https://openrouter.ai/thinkingmachines/inkling:free and https://openrouter.ai/terms (neither documents the 18+ or free-endpoint gate)
- Mistral: https://docs.mistral.ai/admin/overview , https://docs.mistral.ai/resources/known-limitations , https://docs.mistral.ai/admin/monitor-comply/privacy-data-controls (seen via search snippet; direct fetch returned 404)
- Alibaba Model Studio: https://www.alibabacloud.com/help/en/model-studio/error-code , https://www.alibabacloud.com/help/en/model-studio/regions , https://www.alibabacloud.com/help/en/model-studio/model-calling-in-sub-workspace , https://www.alibabacloud.com/help/en/model-studio/model-pricing
- AiHubMix: https://docs.aihubmix.com/en/api/Models-API , https://docs.aihubmix.com/en/FAQs/Faq
- OpenCode Zen: https://opencode.ai/docs/zen/ ; issue https://github.com/ahmadrosid/nakama/issues/1049
- AgentRouter (secondary): https://github.com/agentrouter-org/docs/issues/21
- xkiro: https://docs.xkiro.com/guides/pricing/
- NaraRouter: https://router.bynara.id/docs
- Cloudflare Workers AI: https://developers.cloudflare.com/workers-ai/platform/pricing/ , https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/ , https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/ , https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- Google Gemini: https://ai.google.dev/gemini-api/docs/deprecations
- OrcaRouter: https://docs.orcarouter.ai/routing/free-models

Providers with no reliable public documentation found: kktoken, justdowork, indeedwebid, tabiai, gorouter, seekai, kiosapi (the "No available channel" sentence is only explained by a third-party bug report), vyceai (the "Unsupported client" sentence). Weak or secondary documentation: agentrouter (allow-list from an issue thread), opencode (support channel), mistral (plan names for the "subscription tier" refusal and the exact Labs control), aihubmix (no model status page found).

Steps marked "(not verified: confirm in the provider dashboard)": 16 (the phrase appears 18 times in this file; two occurrences are this line and the definition near the top). Other claims are hedged in prose as inferences or as unverified wherever a sentence says so.

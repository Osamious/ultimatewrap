# UltimateWrap bench study: which models work, which do not, and what to do about it

*Revision 2, after an independent review (`plans/bench-study/review/REVIEW.md`). Every headline number of revision 1 was reproduced by the reviewer; the decision layer (label / hide / remove) was corrected. Section 8 lists old -> new numbers.*

Scope: the 2026-09-29 probe sweeps as recorded (merged) in `~/.uw/state/bench.json` (generatedAt **2026-09-29T14:29:03.034Z**, 5,793 records, probe times 2026-09-29T10:26:25.000Z to 2026-09-29T14:29:02.000Z) joined to `~/.uw/catalog/snapshot.json` (schema 6, generatedAt 2026-08-24T12:22:28.162Z, routableAsOf 2026-09-29T14:29:27.796Z, discoveredAsOf 2026-09-29T09:16:54.456Z, **benchAsOf 2026-09-29T14:29:03.034Z**, builtAt 2026-09-29T14:29:28.029Z). Read-only: nothing in the repo, state or catalog was modified, no request was sent. Also read: the two bench backups (`bench.before-probe-all.json` generatedAt 2026-09-29T12:35:25.113Z, `bench.first-sweep.json` generatedAt 2026-09-29T11:56:31.329Z), the 57 discovery caches (`%LOCALAPPDATA%\uw-keysync\discovery\*.json`, all written 2026-09-29T09:16Z except vyncai 2026-09-19), `refresh/bench.mjs`, `menu/bench-data.mjs`, `state/bench-run3.log`. Provider sentences are redacted before they reach any deliverable (masked key fragments, URLs; see sec 6).

**Unit and denominators.** The unit is a *route*: one snapshot model row (the picker's selectable row). 6,032 routes map to 6,031 unique bench keys: 1,062 routes carry a `[1m]` suffix (the bench key strips it), but only 1 of them has a separate bare-id route in the same provider (teamorouter/kimi-k3[1M]), so nothing is double-counted apart from that one. "Eligible" = routes the engine probes (outputKind not `nontext`, routable not false) = 5,794 routes = 5,793 keys. Unless a sentence names another population, percentages are of the 5,794 eligible routes; provider rates use that provider's eligible routes. **Three groups, said once:** `ok` 1,787 (30.8%) = works; `empty` 76 (1.3%) = the provider answered but no visible text came back (kept as its own group, sec 2.4, never counted as "does not work"); **did not answer** 3,931 (67.8%) = pay, gone, error, auth, rate, timeout.

> **Which sweep does this study cover?** `state/bench.json` is the *merged latest-record-per-key* view, not one sweep. Its 5,793 records come from three writes: **2,226 records are sweep-1 records that were never re-probed** (sweep 1: 2026-09-29T10:26:25.000Z to 2026-09-29T11:56:31.000Z, old classifier, old dead/unfunded breakers, no provider message `m`); **57 records come from a partial second run** (2026-09-29T11:57:27.000Z to 2026-09-29T12:35:25.000Z; 225 records touched, most of which the third run then overwrote); and **3,510 records come from the probe-all run** (2026-09-29T12:43:36.000Z to 2026-09-29T14:29:03.034Z). So the "2,283 carried-over" records in sec 1 are 2,226 from sweep 1 plus 57 from the partial second run. Every number in this report is about that merged final view; the differences between sweep 1 and the final view are in **sec 7 (Sweep comparison)**. Unit there: bench key (5,793 keys; the route counts elsewhere are 1 higher because of one `[1m]` twin).


## 0. Executive summary

**Corrected top-5 actions**

1. **Re-probe before deciding anything about 1,364 routes** (23.5% of 5,794 eligible). This is the honest size of the re-probe set: 609 routes whose primary action is re-probe (270 `fetch failed`, 82 model-not-served, 42 timeout, 26 overloaded, 72 rate, 55 hidden-reasoning `empty` at max_tokens 1024, and the rest of `error`) + 519 routes that get a label AND a re-probe (gone rows, google `models/` rows, `non-chat?`) + 224 remove candidates that rest on a legacy record and need one current-engine probe first + 12 hide-and-re-probe. Settles the `fetch failed` question (270 routes; 13.6% of last-run records inside 13:10-13:50Z vs 4.3% outside, sec 4a).
2. **Label state, never remove it: 2,668 routes** are labelled (pay 1,972, auth 88, gone rows the provider lists or that carry account state, batch-only ids, `needs Responses API?`, `needs other route`, `not activated`). pay/auth/rate/timeout/error/empty are state. Suggested texts in sec 5. Labels are computed from records the picker stops showing after 14 days (**2026-10-13** for the oldest), so schedule a re-sweep.
3. **Hide non-chat and batch ids only when the provider's own sentence or an ok twin says so: 313 routes**, not the 336 of revision 1 (which hid by id pattern). Split: non-chat by the provider's sentence 198 (49 gone incl. openai Responses-API 23 and zenmux /v1/chat/completions 26; 149 error), batch twins whose base id answers ok 103, gone ids that look non-chat 12. **Not hidden, labelled or kept:** 69 batch-only ids (`batch-only`), 4 `:batch` routes that answer ok (kept), 40 error rows with only an id-based hint (`non-chat?`), 9 chat models that need another route (commandcode Claude ids), 1 with no streaming, 1 not activated, the 3 aihubmix Responses-API ids (gpt-5.5-pro, gpt-5.2-pro, o3-pro).
4. **Remove candidates: 361 routes (was 467), and only after a second probe.** Rule: `gone` + explicit not-found wording visible in the stored sentence + catalogue-only provenance AND not named by the provider's listing after normalising google's `models/` prefix and `[1m]` + not the ambiguous "or you do not have access" wording + id does not name a non-chat model + no ok sibling id + never ok/empty in any bench file. Dropped from revision 1: the 90 google rows (7 of them are named by google's own listing; 8 are "no longer available to new users" = account state; most show no verdict in the 40-character snippet; google's sentence is "not found ... or not supported for generateContent"). **Caveat that limits every candidate:** all evidence is one probe on one day (1 calendar day; 0 of 361 have two `gone` probes; 0 routes changed from ok to non-ok between files) and compaction prunes old records, so "never answered" is not a durable guarantee. Require a persistent ever-ok ledger and two independent `gone` probes on different days before any automated removal.
5. **Fund by listed models, and verify the sambanova credential before replacing it.** Rank top-ups by pay routes the provider's own listing names (sec 4e): kilo 350, experientiallabs 267, orcarouter 160, zenmux 143, tokenrouter 133. **deepseek is not a top-up priority:** 94 pay routes in the catalogue, but its listing names 2 models and 93 of the 94 are catalogue-only, so a top-up unlocks about 1. sambanova: its discovery call returned 200 with 7 models while all 7 probes say "Incorrect API key": check which credential the gateway sends versus the vault key before replacing anything (sec 4d).

**Headline numbers**

- **Population.** 6,032 routes in the snapshot (57 providers); 238 non-chat, never probed; **5,794 eligible**. All 5,794 eligible routes hold a non-skip record inside the picker's 14-day window, so **pending = 0** (sec 1 explains why).
- **Works:** 1,787 of 5,794 eligible routes answered `ok` (30.8%). 14 of 57 providers are healthy (ok-rate >= 50% of their routes) and hold 1,421 of the 1,787 ok routes (79.5%). **Answered but no text (`empty`):** 76 (55 spent the 96-token budget on hidden reasoning). **Did not answer:** 3,931 (67.8%): pay 1,972 (34.0%), gone 1,138 (19.6%), error 619, auth 88, rate 72, timeout 42. Five providers hold 1,062 of the 1,972 `pay` routes (kilo, experientiallabs, orcarouter, zenmux, tokenrouter).
- **Probe artefacts, not model state.** 270 of the 619 `error` routes are `fetch failed` (no HTTP response reached the probe; 13.6% of last-run records inside 13:10-13:50Z vs 4.3% outside vs 0.8% of sweep-1 real results; 23 same-second bursts across 3+ providers; 30 providers).
- **What the second sweep changed.** Of 5,793 bench keys, sweep 1 had ok 1,396 (24.1%) and left 3,125 (53.9%) unprobed (`skip`: 1,878 unfunded, 974 provider-dead, 271 spend-cap, 2 row-cost); the final view has ok 1,787 (30.8%), +391, and 0 skips. 367 of the 3,125 skipped rows turned out ok (393 answered incl. empty) but 1,825 came back `pay` and 513 `gone`, so unfunded/dead skipping was mostly right about the money and wrong about 12 providers that in fact answer: experientiallabs 0->10, orcarouter 0->2, veniceai 0->3, commandcode 0->2, bai 0->2, nararouter 0->10, teamorouter 0->2, agentrouter 0->1, tokenrouter 0->3, opencode 0->3, openai 0->46, mistral 0->20 (ok keys, sweep 1 -> final). No sweep-1 non-transient result (2,226 rows) was ever re-probed, so the 2,226 legacy records are unconfirmed rather than confirmed.
- **Legacy records.** 2,283 of 5,794 eligible routes (39.4%) still carry a record from sweep 1 or the partial second run (10:26-12:35Z, old classifier, no provider message `m`); 879 of 4,007 non-ok routes have no `m`. All are non-transient (ok 1,404, pay 179, gone 605, auth 47, empty 48; 0 error/rate/timeout). A default run re-probes records older than the **7-day** ttl (from 2026-10-06T10:26Z); the picker stops showing a record as current after **14 days** (from 2026-10-13T10:26Z).
- **Timing.** Separated, never mixed: 1,450 of 1,787 ok routes (81.1%) delivered the whole answer as one burst, so their "TTFT" is time to the whole answer (median 9,187 ms); only 337 routes (18.9%) have a real time to first token (median 7,575 ms). Last-run timings are ~42% slower than earlier records (median TTFT 11,682 vs 8,248 ms, gateway degradation and a different provider mix), so cross-run comparison is unsafe and this study makes no speed recommendation.

## 0b. Confidence: what is solid, what is shaky, and what settles each

**Solid** (reproduced exactly by the independent reviewer or verified against source): population and denominators; the status distribution; ok-rate for all 57 providers; the 14 healthy providers' 79.5% share of ok; the five-provider pay concentration; the `fetch failed` count and provider spread; legacy counts (2,283 records, 879 without `m`, 0 transient); the 81% one-burst figure and the TTFT statistics; pending = 0; the pay cause clusters (reviewer sample: **pay 30/30 causes right, status right in all 90 sampled rows**); mistral's and alibaba's remove-candidate lists as written; the direction of the `fetch failed` conclusion.

**Sample accuracy of the cause clusters (reviewer, revision-1 rules):** pay 30/30, gone 22/30, error 24/30 correct causes; status right in all 90. The misses drove the rule changes listed in sec 6 ("Rules changed"): aihubmix "cannot be served ... check the model ID" filed as overload, non-chat ids inside the shape/opaque error buckets, openai/zenmux explicit non-chat sentences filed as "listed but 404", google new-user restrictions and group entitlements filed as gone.

| Conclusion | Confidence | Why | What would settle it |
|---|---|---|---|
| Google's former 90 remove candidates are gone | **dropped** | Evidence is a 40-character prefix; 7 are named by google's listing; 8 are new-user restrictions; google's sentence also says "or not supported for generateContent" | One current-engine probe of the 95 google `models/` rows (full sentence stored in `m`), compared with the listing after prefix stripping |
| Alibaba 190 / mistral 126 candidates are permanently gone | shaky | One probe each, one day; 12 alibaba and 8 mistral catalogue-only ids DO answer ok (so catalogue-only is not a reliable death signal); "Model not exist." can also mean region or activation | A second probe on another day; for alibaba one call through the other region endpoint if available |
| Non-chat / batch hiding | conditional | Now message- and ok-twin-conditional; 4 of 177 `:batch` routes answer ok; aihubmix Responses-API ids and 12 error rows were chat models | Manual pass over the rows with no non-chat token in the id; re-probe the `needs other route` / `no streaming` rows through the right route |
| `fetch failed` is a gateway/probe artefact | likely, not proven | 13.6% of last-run records in 13:10-13:50Z vs 4.3% outside vs 0.8% in sweep 1; 23 same-second bursts across 3-6 providers; 24 refused in under 100 ms. The run log has no outage timestamps, and 4.3% background means not every one is the gateway | Re-probe the 270 routes (expected: mostly ok or their true state); compare with the CCR gateway log for the 12 stalls |
| Top-up value per provider | upper bounds | payment-first providers hide existence errors; conditional rates use small, free-tier-survivor denominators | Probe one listing-verified pay route per provider after a small top-up, or read the provider's pricing page; estimates below n=30 are not shown |
| sambanova needs a new key | unverified | The listing call returned 200 with 7 models; the probe says 'Incorrect API key' for all 7 (stable across 10-11Z and 14Z) | Compare the credential in the vault with the one the gateway sends; make one direct call outside the sweep |
| Speed | weak | 81.1% burst rows, single sample, last-run timings ~42% slower | Repeat 3 samples per route at low concurrency, streamed and burst reported separately |
| "Never answered in any of the three bench files" | vacuous today | All three files are from one day; 0 routes went ok -> non-ok; 0 of 361 candidates have two `gone` probes; compaction prunes old records | A persistent ever-ok ledger, and two independent `gone` probes on different days before removal |


## 1. Population overview

| Stage | Routes | Denominator / note |
|---|---|---|
| Routes in snapshot | 6,032 | 57 providers; 6,031 unique bench keys |
| Non-chat, excluded (outputKind nontext) | 238 | 3.9% of 6,032 routes; 0 routes have routable=false |
| Eligible for probe | 5,794 | 96.1% of 6,032 routes; outputKind text 3,811, unknown (null) 1,983 are all probed |
| Probed with a fresh result | 5,794 | 100.0% of eligible; fresh = record <= 14 d old at benchAsOf (the picker's display rule) |
| Pending (no fresh result) | 0 | 0 eligible routes lack a record; 0 records are `skip` |
|   of the probed: written by the last (probe-all) run, 12:43-14:29Z | 3,511 | 60.6% of eligible |
|   of the probed: carried over unchanged (sweep 1 and the partial second run, 10:26-12:35Z) | 2,283 | 39.4% of eligible; identical to the pre-probe-all backup; all non-transient |


**Status distribution over the 5,794 probed eligible routes**

| Group | Status | Routes | % of eligible | of which legacy record | Meaning (bench-data.mjs) |
|---|---|---|---|---|---|
| works | ok | 1,787 | 30.8% | 1,404 | stream with content arrived |
| answered, no text | empty | 76 | 1.3% | 48 | HTTP 200 + stream, no content |
| did not answer | pay | 1,972 | 34.0% | 179 | account cannot use the model until funded/upgraded |
| did not answer | gone | 1,138 | 19.6% | 605 | 404 or a not-found/removed sentence |
| did not answer | error | 619 | 10.7% | 0 | 5xx, network failure, malformed stream, model rejects the request |
| did not answer | auth | 88 | 1.5% | 47 | 401/403 (key or per-model entitlement) |
| did not answer | rate | 72 | 1.2% | 0 | 429 or quota message |
| did not answer | timeout | 42 | 0.7% | 0 | no complete answer in 35 s |
| **total** |  | 5,794 | 100% | 2,283 | did not answer = 3,931 (67.8%) |


**About "pending".** pending = 0 is right, and the reason is *not* that rows carry a legacy record. (1) `bench-run3.log` says "3510 row(s) to probe (2283 already fresh)" and "finished -- 3510 recorded": planned equals recorded, and diffing `bench.json` against `bench.before-probe-all.json` (12:35Z, before the run) gives 3,510 keys with a new record (earliest 12:43:36Z) and 2,283 unchanged. (2) The engine re-queues outage-hit rows inside the same run: `runSweep` calls `requeue()` for rows that hit a confirmed gateway outage, puts them back in their provider queue and re-probes them after the gateway answers. The log's closing sentence ("401 row(s) hit by it were put back UNRECORDED (they are re-probed on the next run)") is generic wording that describes the aborted case (`stop = "outage"`), which did not happen (the run finished). The timestamps show the trace: 4 silent gaps of >= 45 s between 14:16 and 14:27Z and 264 keys recorded within 2 minutes after them, all unfunded-provider rows that came back `pay` (sec 7.7); that is a floor for the requeued rows, not their count. (3) All 2,283 legacy records are non-transient (ok 1,404, pay 179, gone 605, auth 47, empty 48; 0 error/rate/timeout/skip), because the last run re-probed every skip and every transient record from the backup (3,203 skip + 307 error/rate/timeout = 3,510). **Two different dates apply to those legacy records:** a default run re-probes a record only after the **7-day ttl** (`ttlDays = 7`: from 2026-10-06T10:26Z to 2026-10-06T12:35Z), whereas the **picker's display rule** stops showing a record as current after **14 days** (`BENCH_FRESH_MS`: from 2026-10-13T10:26Z). What the outage window did leave behind is contamination of recorded rows, not missing rows: 270 `fetch failed` routes (7.7% of the 3,511 last-run routes). The exact 401 held keys cannot be recovered from the files.

**Per provider (all 57).** ok-rate = ok / probed. verdict = provider-level reading with `fetch failed` rows excluded (`verdict_excl_fetch_failed` in providers.csv): healthy >= 50% ok, partial 10-50%, mostly-blocked < 10% but answering, needs-money every remaining row `pay`, dead nothing answered and only auth/error/timeout/gone. (`inceptionlabs`, 2 `empty` and 0 ok, is listed as mostly-blocked: it answers.)

| provider | eligible | probed | ok | empty | pay | auth | gone | error | timeout | rate | pending | ok-rate | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| openrouter | 469 | 469 | 236 | 3 | 119 | 6 | 86 | 17 | 1 | 1 | 0 | 50.3% | healthy |
| aihubmix | 424 | 424 | 272 | 20 | 3 | 19 | 24 | 70 | 7 | 9 | 0 | 64.2% | healthy |
| alibaba | 419 | 419 | 107 | 1 | 1 | 17 | 224 | 64 | 5 | 0 | 0 | 25.5% | partial |
| infron | 411 | 411 | 253 | 12 | 0 | 0 | 9 | 131 | 6 | 0 | 0 | 61.6% | healthy |
| kilo | 403 | 403 | 7 | 0 | 359 | 0 | 13 | 24 | 0 | 0 | 0 | 1.7% | mostly-blocked |
| nousresearch | 393 | 393 | 288 | 8 | 0 | 0 | 68 | 26 | 2 | 1 | 0 | 73.3% | healthy |
| openai | 324 | 324 | 46 | 16 | 0 | 0 | 257 | 5 | 0 | 0 | 0 | 14.2% | partial |
| experientiallabs | 297 | 297 | 10 | 0 | 267 | 0 | 0 | 20 | 0 | 0 | 0 | 3.4% | mostly-blocked |
| zenmux | 208 | 208 | 6 | 0 | 143 | 0 | 42 | 17 | 0 | 0 | 0 | 2.9% | mostly-blocked |
| mistral | 200 | 200 | 20 | 0 | 0 | 8 | 144 | 7 | 0 | 21 | 0 | 10.0% | partial |
| orcarouter | 180 | 180 | 2 | 0 | 160 | 0 | 1 | 12 | 0 | 5 | 0 | 1.1% | mostly-blocked |
| google | 161 | 161 | 9 | 0 | 0 | 0 | 113 | 22 | 0 | 17 | 0 | 5.6% | mostly-blocked |
| tokenrouter | 142 | 142 | 3 | 0 | 133 | 0 | 1 | 5 | 0 | 0 | 0 | 2.1% | mostly-blocked |
| huggingface | 134 | 134 | 123 | 0 | 1 | 0 | 8 | 2 | 0 | 0 | 0 | 91.8% | healthy |
| xkiro | 132 | 132 | 53 | 0 | 71 | 2 | 0 | 5 | 1 | 0 | 0 | 40.2% | partial |
| pollinations | 131 | 131 | 106 | 0 | 15 | 0 | 0 | 10 | 0 | 0 | 0 | 80.9% | healthy |
| veniceai | 126 | 126 | 3 | 0 | 114 | 0 | 0 | 9 | 0 | 0 | 0 | 2.4% | mostly-blocked |
| nvidia | 111 | 111 | 9 | 1 | 0 | 0 | 91 | 2 | 8 | 0 | 0 | 8.1% | mostly-blocked |
| deepseek | 106 | 106 | 0 | 0 | 94 | 0 | 0 | 12 | 0 | 0 | 0 | 0.0% | needs-money |
| opencode | 98 | 98 | 3 | 0 | 57 | 12 | 0 | 26 | 0 | 0 | 0 | 3.1% | mostly-blocked |
| commandcode | 84 | 84 | 2 | 0 | 63 | 0 | 0 | 19 | 0 | 0 | 0 | 2.4% | mostly-blocked |
| gmicloudai | 77 | 77 | 0 | 0 | 66 | 0 | 2 | 9 | 0 | 0 | 0 | 0.0% | no-answer (mixed) |
| anymodel | 75 | 75 | 68 | 1 | 0 | 0 | 5 | 1 | 0 | 0 | 0 | 90.7% | healthy |
| tokenharbor | 63 | 63 | 9 | 0 | 53 | 0 | 0 | 1 | 0 | 0 | 0 | 14.3% | partial |
| kiraai | 60 | 60 | 2 | 7 | 45 | 0 | 0 | 6 | 0 | 0 | 0 | 3.3% | mostly-blocked |
| cloudflare | 59 | 59 | 17 | 3 | 0 | 8 | 3 | 28 | 0 | 0 | 0 | 28.8% | partial |
| bai | 59 | 59 | 2 | 0 | 52 | 0 | 0 | 5 | 0 | 0 | 0 | 3.4% | mostly-blocked |
| nararouter | 54 | 54 | 10 | 0 | 14 | 1 | 1 | 10 | 0 | 18 | 0 | 18.5% | partial |
| llm7 | 49 | 49 | 5 | 0 | 39 | 0 | 0 | 5 | 0 | 0 | 0 | 10.2% | partial |
| teamorouter | 46 | 46 | 2 | 0 | 35 | 0 | 0 | 8 | 1 | 0 | 0 | 4.3% | mostly-blocked |
| cohere | 37 | 37 | 18 | 0 | 0 | 0 | 10 | 8 | 1 | 0 | 0 | 48.6% | partial |
| apinex | 34 | 34 | 2 | 0 | 28 | 0 | 1 | 3 | 0 | 0 | 0 | 5.9% | mostly-blocked |
| ollama | 31 | 31 | 6 | 0 | 11 | 0 | 14 | 0 | 0 | 0 | 0 | 19.4% | partial |
| nscale | 21 | 21 | 21 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100.0% | healthy |
| hcnsec | 20 | 20 | 12 | 0 | 0 | 0 | 4 | 0 | 4 | 0 | 0 | 60.0% | healthy |
| bluesminds | 18 | 18 | 4 | 2 | 0 | 0 | 8 | 1 | 3 | 0 | 0 | 22.2% | partial |
| chutes | 14 | 14 | 0 | 0 | 14 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | needs-money |
| anthropic | 13 | 13 | 13 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100.0% | healthy |
| groq | 12 | 12 | 5 | 0 | 0 | 0 | 3 | 4 | 0 | 0 | 0 | 41.7% | partial |
| routllm | 12 | 12 | 0 | 0 | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | needs-money |
| agnes | 12 | 12 | 3 | 0 | 0 | 0 | 0 | 6 | 3 | 0 | 0 | 25.0% | partial |
| seekai | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 12 | 0 | 0 | 0 | 0.0% | dead |
| fanar | 11 | 11 | 6 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 54.5% | healthy |
| bigmodel | 11 | 11 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100.0% | healthy |
| vyceai | 7 | 7 | 6 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 85.7% | healthy |
| cerebras | 7 | 7 | 0 | 0 | 2 | 0 | 5 | 0 | 0 | 0 | 0 | 0.0% | no-answer (mixed) |
| sambanova | 7 | 7 | 0 | 0 | 0 | 7 | 0 | 0 | 0 | 0 | 0 | 0.0% | dead |
| aionlabs | 6 | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100.0% | healthy |
| agentrouter | 5 | 5 | 1 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 20.0% | partial |
| inceptionlabs | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | mostly-blocked |
| xai | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | needs-money |
| tabiai | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0.0% | dead |
| gorouter | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0.0% | dead |
| indeedwebid | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0.0% | dead |
| kiosapi | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0.0% | dead |
| kktoken | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0.0% | dead |
| justdowork | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0.0% | dead |


Verdict counts over 57 providers: healthy 14, partial 14, mostly-blocked 15, needs-money 4, no-answer (mixed) 2, dead 8. **Versus the snapshot's `benchFlags`:** the snapshot's `dead` set is the same 8 providers as this report's `dead` verdict (seekai, sambanova, tabiai, gorouter, indeedwebid, kiosapi, kktoken, justdowork); `needsMoney` differs: the snapshot has 3 (chutes, routllm, xai), this report 4 (deepseek added). The reason: the snapshot rule requires that *every* fresh record is `pay` or an unfunded skip, and deepseek has 94 `pay` rows plus 12 `fetch failed` errors; this report excludes `fetch failed` rows as probe artefacts, so deepseek reads needs-money here. Neither rule is stricter for `dead`.

## 2. What works

### 2.1 The ok population (1,787 of 5,794 eligible routes, 30.8%)

| Badge | ok routes | eligible routes | ok-rate (ok / eligible in that group) |
|---|---|---|---|
| (blank) | 1,204 | 4,171 | 28.9% |
| PAID | 469 | 1,403 | 33.4% |
| FREE? | 101 | 207 | 48.8% |
| PLAN | 13 | 13 | 100.0% |

The blank badge (no free/paid claim) is 1,204 of the 1,787 ok routes (67.4%). `FREE` has no eligible routes in this snapshot (the badge only shows `FREE?`, 207 eligible routes, 101 ok = 48.8%). Only 13 PLAN routes exist, all ok (100.0%).

| Provenance (as stored in the snapshot) | ok routes | eligible routes | ok-rate (ok / eligible in that group) |
|---|---|---|---|
| listing-verified | 1,748 | 4,787 | 36.5% |
| catalogue-only | 35 | 986 | 3.5% |
| config-asserted | 4 | 21 | 19.0% |

`call-verified` and null provenance do not occur among eligible routes. **The stored `catalogue-only` label is partly an artefact:** google's listing ids are `models/<id>` and its routes may carry `[1m]`, so the snapshot does not see that the listing names them. After normalising both, 40 of the 986 catalogue-only eligible routes are in fact named by the provider's own listing (all google, 0 in the other 56 providers; the exact-id check finds 0), and **4 of the 35 "ok, catalogue-only" routes are named by the listing** (google/gemini-3.1-flash-lite, google/gemini-3.1-flash-lite-preview, google/gemini-3.5-flash-lite, google/gemini-3.8-flash). Corrected: 31 ok routes are genuinely catalogue-only (the provider answers for an id its listing does not name: alibaba 12, aihubmix 8, mistral 8, cohere 2, openai 1), so do not remove on provenance alone; 1,752 of 1,787 ok routes (98.0%) are named by the listing.

| Context band | ok routes | eligible routes | ok-rate (ok / eligible in that group) |
|---|---|---|---|
| unknown | 829 | 2,626 | 31.6% |
| 256k-1M | 320 | 992 | 32.3% |
| 128k-256k | 302 | 860 | 35.1% |
| 32k-128k | 188 | 685 | 27.4% |
| >1M | 96 | 311 | 30.9% |
| 8k-32k | 41 | 199 | 20.6% |
| <=8k | 11 | 121 | 9.1% |

ctx is unknown for 2,626 of 5,794 eligible routes (45.3%), so band-level rates are partial.

| Capability flag (snapshot) | ok routes with flag | eligible routes with flag | ok-rate among flagged | flagged share of ok |
|---|---|---|---|---|
| tools | 1,073 | 2,903 | 37.0% | 60.0% |
| vision | 711 | 2,121 | 33.5% | 39.8% |
| reason | 905 | 2,491 | 36.3% | 50.6% |

Note that the probe sends no tools: `tools ok` means "answers a bare chat request", not "handles tool schemas" (#118/#119). 392 of 1,787 ok routes (21.9%) show only thinking text in the preview (`k=1`): the stream had content, but within 96 tokens the model had not begun its answer. They count as ok by the engine's definition; a bigger budget would confirm they finish.

### 2.2 Providers by ok-rate

**High (ok-rate >= 50%, >= 5 probed routes):** nscale 100.0% (21/21); anthropic 100.0% (13/13); bigmodel 100.0% (11/11); aionlabs 100.0% (6/6); huggingface 91.8% (123/134); anymodel 90.7% (68/75); vyceai 85.7% (6/7); pollinations 80.9% (106/131); nousresearch 73.3% (288/393); aihubmix 64.2% (272/424); infron 61.6% (253/411); hcnsec 60.0% (12/20); fanar 54.5% (6/11); openrouter 50.3% (236/469).

**Low (ok-rate < 10%, >= 5 probed routes):** sambanova 0.0% (0/7); cerebras 0.0% (0/7); seekai 0.0% (0/12); routllm 0.0% (0/12); chutes 0.0% (0/14); gmicloudai 0.0% (0/77); deepseek 0.0% (0/106); orcarouter 1.1% (2/180); kilo 1.7% (7/403); tokenrouter 2.1% (3/142); commandcode 2.4% (2/84); veniceai 2.4% (3/126); zenmux 2.9% (6/208); opencode 3.1% (3/98); kiraai 3.3% (2/60); experientiallabs 3.4% (10/297); bai 3.4% (2/59); teamorouter 4.3% (2/46); google 5.6% (9/161); apinex 5.9% (2/34); nvidia 8.1% (9/111).

Only providers with >= 5 probed routes are listed; providers with 1-4 routes (tabiai, gorouter, indeedwebid, kiosapi, kktoken, justdowork, xai, inceptionlabs) are in sec 4f.

### 2.3 Performance of the ok routes (two populations, never mixed)

**Why two populations.** For 1,450 of 1,787 ok routes (81.1%) total time minus TTFT is <= 50 ms: the text arrived as one chunk (the gateway or the provider buffers the stream). For those, `t` is **time to the whole answer**, not time to first token, and tokens/s is null. Only 337 routes (18.9%) streamed incrementally, and only for those is `t` a real **time to first token**. A single "TTFT" column over both is not a first-token measure, so this section reports them separately and offers no combined ranking.

| Population | n (ok routes) | measure | p10 ms | median ms | p90 ms | min ms | max ms |
|---|---|---|---|---|---|---|---|
| streamed | 337 | time to first token (TTFT) | 4,055 | 7,575 | 12,681 | 1,753 | 28,384 |
| streamed | 337 | total time | 6,418 | 12,443 | 24,483 | 2,228 | 34,844 |
| burst | 1,450 | time to the WHOLE answer | 5,282 | 9,187 | 16,613 | 1,390 | 34,336 |

Tokens per second exists for only 311 of the 1,787 ok routes (17.4%): p10 10.1, median 37.9, p90 128.9 (min 1.0, max 463.0). Of the 1,476 routes with null tokens/s, 415 produced < 8 output tokens (by design) and 1,061 produced >= 8 but arrived as a single burst.

**Cross-run comparison is unsafe.** The last (probe-all) run's records are slower than the carried-over ones: all-ok median TTFT 11,682 ms (n 383) vs 8,248 ms (n 1,404), i.e. ~42% slower; the same gap holds inside each population (burst 11,884 vs 8,557 ms; streamed 9,687 ms, n 29, vs 7,465 ms, n 308). Candidates: the 13:10-13:50Z gateway degradation and a different provider mix (the last run probed formerly skipped, paid and failing rows); I did not isolate the cause. A provider's place in any speed ordering therefore depends on which run measured it (the "legacy share" column below). Further caveats: single sample per route under 8-way concurrency through a shared gateway; reasoning models show thinking first (`k=1`, 392 routes), so their first token is a thinking token; 593 ok routes reported output_tokens >= 96 and 177 more than 96 (those providers ignore max_tokens). **Not a recommendation input:** the lists below are descriptive.

**25 fastest streamed routes by time to first token** (streamed, answer preview; ms):

| # | route | badge | TTFT ms | total ms | tok/s | out tokens | run |
|---|---|---|---|---|---|---|---|
| 1 | aihubmix/doubao-seed-2-1-pro |  | 1,753 | 10,390 | 25.7 | 222 | earlier |
| 2 | alibaba/qwen3.6-27b | PAID | 1,783 | 8,638 | 62.4 | 428 | earlier |
| 3 | aihubmix/qwen3-235b-a22b-thinking-2507 |  | 1,925 | 21,585 | 99.9 | 1962 | earlier |
| 4 | openrouter/mistralai/mistral-small-3.2-24b-instruct | PAID | 2,092 | 2,228 | 68.7 | 9 | earlier |
| 5 | openrouter/laguna-s-2.1:free | FREE? | 2,095 | 3,146 | 7.6 | 8 | earlier |
| 6 | infron/qwen/qwen3.5-122b-a10b |  | 2,386 | 13,344 | 128.9 | 1412 | earlier |
| 7 | huggingface/moonshotai/Kimi-K2-Instruct-0905 | PAID | 2,646 | 3,517 | 9.2 | 8 | earlier |
| 8 | openrouter/wizardlm-2-8x22b | PAID | 2,683 | 7,012 | 2.1 | 9 | earlier |
| 9 | alibaba/qwen3.7-max | PAID | 2,683 | 12,590 | 87.3 | 865 | earlier |
| 10 | openai/gpt-5.4-mini-2026-03-17 | PAID | 2,724 | 3,665 | 12.8 | 12 | last |
| 11 | huggingface/CohereLabs/aya-vision-32b |  | 2,779 | 6,414 | 26.4 | 96 | earlier |
| 12 | huggingface/deepseek-ai/DeepSeek-V3-0324 | PAID | 2,789 | 4,735 | 5.1 | 10 | earlier |
| 13 | aihubmix/qwen3-vl-plus |  | 2,795 | 2,946 | 93.8 | 9 | earlier |
| 14 | alibaba/qwen3.5-35b-a3b | PAID | 2,919 | 32,222 | 187.8 | 5327 | earlier |
| 15 | alibaba/deepseek-v4-pro |  | 2,960 | 6,491 | 23.8 | 84 | earlier |
| 16 | nousresearch/qwen/qwen3.8-omni-flash |  | 3,018 | 3,895 | 135.7 | 119 | earlier |
| 17 | openrouter/qwen/qwen3.5-flash-02-23 | PAID | 3,480 | 4,992 | 63.5 | 96 | earlier |
| 18 | infron/z-ai/glm-5v-turbo |  | 3,550 | 4,419 | 9.2 | 8 | earlier |
| 19 | hcnsec/DeepSeek-V4-Pro |  | 3,572 | 4,504 | - | 8 | earlier |
| 20 | aihubmix/laguna-s-2.1-free | FREE? | 3,581 | 4,450 | 9.2 | 8 | last |
| 21 | alibaba/qwen3-next-80b-a3b-thinking | PAID | 3,787 | 13,666 | 198.7 | 1963 | earlier |
| 22 | alibaba/qwen3.8-max | PAID | 3,866 | 7,808 | 34.8 | 137 | earlier |
| 23 | nararouter/claude-opus-5 |  | 3,973 | 6,961 | 4.7 | 14 | last |
| 24 | openrouter/hunyuan-a13b-instruct | PAID | 4,356 | 9,131 | 59.0 | 280 | earlier |
| 25 | nousresearch/qwen/qwen3.6-max-preview |  | 4,359 | 23,057 | 75.1 | 1405 | earlier |

**25 slowest streamed routes by time to first token** (the probe timeout is 35 s so the tail is capped; `think` = preview was reasoning text):

| # | route | badge | TTFT ms | total ms | tok/s | out tokens | think | run |
|---|---|---|---|---|---|---|---|---|
| 1 | hcnsec/step-5-preview |  | 28,384 | 31,072 | 35.7 | 96 | yes | earlier |
| 2 | nvidia/meta/muse-glimmer-30b | FREE? | 25,180 | 29,615 | 21.7 | 96 | yes | earlier |
| 3 | anymodel/am/kimi-k3 |  | 24,681 | 29,273 | - | 29 |  | last |
| 4 | nousresearch/openai/gpt-5-pro |  | 24,623 | 26,396 | 36.1 | 64 | yes | last |
| 5 | vyceai/gpt-6-luna |  | 23,816 | 24,298 | 45.8 | 12 |  | earlier |
| 6 | aihubmix/qwen3.5-397b-a17b |  | 22,147 | 24,801 | 319.2 | 847 |  | earlier |
| 7 | anymodel/qwen/qwen3.7-plus |  | 21,418 | 34,238 | 71.9 | 922 |  | earlier |
| 8 | anymodel/am/nemotron-3.5-lightning-30b-a3b |  | 20,496 | 29,149 | - | 3 |  | earlier |
| 9 | openrouter/x-ai/grok-4.6 | PAID | 18,364 | 22,053 | 162.1 | 598 |  | earlier |
| 10 | openrouter/qwen/qwen3.8-2.4t-a95b | PAID | 18,211 | 19,507 | 74.1 | 96 | yes | earlier |
| 11 | bluesminds/openai/gpt-oss-20b |  | 16,723 | 20,603 | 24.7 | 96 | yes | last |
| 12 | aihubmix/ernie-5.0 |  | 16,684 | 20,284 | 26.1 | 94 | yes | earlier |
| 13 | alibaba/kimi-k2.7-code |  | 16,611 | 21,094 | 32.1 | 144 |  | earlier |
| 14 | nousresearch/qwen/qwen3-32b |  | 16,434 | 22,299 | 16.4 | 96 | yes | last |
| 15 | kiraai/kira-mini-1.0 |  | 16,244 | 20,387 | 183.5 | 760 |  | earlier |
| 16 | aihubmix/ernie-5.0-thinking-preview |  | 15,929 | 17,866 | 49.5 | 96 | yes | last |
| 17 | openrouter/qwen/qwen3-14b | PAID | 15,759 | 20,391 | 20.7 | 96 | yes | earlier |
| 18 | infron/qwen/qwen3-14b |  | 15,592 | 23,563 | 102.0 | 813 |  | earlier |
| 19 | aihubmix/qwen3-14b |  | 15,545 | 22,939 | 53.4 | 395 |  | last |
| 20 | nousresearch/z-ai/glm-5.1 |  | 15,369 | 17,969 | 36.9 | 96 | yes | earlier |
| 21 | infron/volcengine/doubao-seed-2.0-code |  | 15,282 | 20,012 | 87.1 | 412 |  | earlier |
| 22 | xkiro/minimax/minimax-m2.1-highspeed:free | FREE? | 14,984 | 18,300 | 29.0 | 96 | yes | earlier |
| 23 | alibaba/qwen3.8-2.4t-a95b |  | 14,731 | 16,519 | 78.3 | 140 |  | earlier |
| 24 | aihubmix/glm-5-turbo |  | 14,690 | 16,429 | 55.2 | 96 | yes | earlier |
| 25 | aihubmix/qwen3.5-122b-a10b |  | 14,601 | 34,480 | 95.1 | 1890 |  | earlier |

**25 fastest burst routes by time to the whole answer** (burst, answer preview; NOT time to first token):

| # | route | badge | time to whole answer ms | out tokens | run |
|---|---|---|---|---|---|
| 1 | aihubmix/gemini-2.5-flash-lite-preview-09-2025-nothink |  | 1,390 | 9 | earlier |
| 2 | openrouter/laguna-s-2.1 | PAID | 1,879 | 8 | earlier |
| 3 | aihubmix/gpt-4.1-mini |  | 2,020 | 7 | earlier |
| 4 | openrouter/openai/gpt-3.5-turbo-0613 | PAID | 2,185 | 7 | earlier |
| 5 | openrouter/qwen/qwen3-max | PAID | 2,627 | 7 | earlier |
| 6 | alibaba/qwen-plus-2025-04-28 |  | 2,634 | 7 | earlier |
| 7 | openrouter/mistralai/codestral-2508 | PAID | 2,639 | 8 | earlier |
| 8 | openrouter/solar-pro4 | PAID | 2,640 | 8 | earlier |
| 9 | pollinations/openai/gpt-5.4-mini |  | 2,645 | 0 | earlier |
| 10 | infron/google/gemini-3.1-flash-lite |  | 2,649 | 7 | earlier |
| 11 | openrouter/deepseek/deepseek-v4-flash | PAID | 2,667 | 9 | earlier |
| 12 | infron/openai/gpt-6-sol |  | 2,682 | 41 | earlier |
| 13 | aionlabs/aion-labs/aion-rp-llama-3.1-8b |  | 2,699 | 18 | earlier |
| 14 | alibaba/qwen3-vl-plus-2025-09-23 |  | 2,804 | 8 | earlier |
| 15 | alibaba/qwen3-coder-plus | PAID | 2,859 | 7 | earlier |
| 16 | experientiallabs/claude-opus-5.5 |  | 3,144 | 14 | last |
| 17 | alibaba/qwen3-max | PAID | 3,148 | 7 | earlier |
| 18 | aihubmix/gpt-5-chat-latest |  | 3,184 | 11 | earlier |
| 19 | nousresearch/nvidia/nemotron-3-ultra-550b-a55b |  | 3,215 | 22 | earlier |
| 20 | aihubmix/gpt-5.6-sol-disc |  | 3,248 | 44 | earlier |
| 21 | infron/deepseek/deepseek-v4-pro |  | 3,400 | 9 | earlier |
| 22 | openai/gpt-5.4-nano-2026-03-17 | PAID | 3,502 | 11 | last |
| 23 | infron/qwen/qwen3.8-27b:free | FREE? | 3,508 | 8 | earlier |
| 24 | nvidia/meta/llama-3.2-11b-vision-instruct | FREE? | 3,512 | 8 | earlier |
| 25 | openrouter/mistralai/mistral-small-3.1-24b-instruct | PAID | 3,514 | 8 | earlier |

**25 slowest burst routes by time to the whole answer:**

| # | route | badge | time to whole answer ms | out tokens | think | run |
|---|---|---|---|---|---|---|
| 1 | google/gemini-flash-latest | PAID | 34,336 | 4 |  | earlier |
| 2 | nararouter/agnes-2.5-flash |  | 33,325 | 26 |  | last |
| 3 | openai/gpt-5.4-pro-2026-03-05 | PAID | 32,683 | 91 |  | last |
| 4 | aihubmix/qwen3.8-flash |  | 30,996 | 186 |  | earlier |
| 5 | aihubmix/gpt-5.1 | PAID | 30,690 | 17 |  | earlier |
| 6 | infron/openai/gpt-5.1 |  | 30,381 | 17 |  | earlier |
| 7 | hcnsec/DeepSeek-V4.1-Flash |  | 28,471 | 96 | yes | earlier |
| 8 | aihubmix/grok-4-20-non-reasoning |  | 28,004 | 7 |  | earlier |
| 9 | infron/deepseek/deepseek-v4.1-flash:free | FREE? | 27,771 | 7 |  | earlier |
| 10 | anymodel/qwen/qwen3.7-max |  | 27,740 | 7 |  | earlier |
| 11 | aihubmix/gpt-5.4-pro |  | 27,619 | 86 |  | earlier |
| 12 | nararouter/nemotron-3.5-lightning-free | FREE? | 27,296 | 698 |  | last |
| 13 | aihubmix/gpt-5-codex |  | 26,593 | 60 |  | last |
| 14 | aihubmix/gemini-3.1-flash-image |  | 26,317 | 7 |  | earlier |
| 15 | mistral/codestral-2405 | PAID | 26,266 | 8 |  | last |
| 16 | aihubmix/gpt-5.3-chat-latest |  | 26,248 | 12 |  | earlier |
| 17 | pollinations/community/MarcosFRG/glm-5.3-flash |  | 26,221 | 0 |  | last |
| 18 | pollinations/community/MarcosFRG/metraxai |  | 26,145 | 0 |  | last |
| 19 | aihubmix/gpt-5.2 | PAID | 26,114 | 11 |  | earlier |
| 20 | infron/z-ai/glm-4.5-flash |  | 26,024 | 96 | yes | earlier |
| 21 | infron/z-ai/glm-5 |  | 25,678 | 6 |  | earlier |
| 22 | openrouter/minimax/minimax-m3 | PAID | 25,608 | 96 | yes | earlier |
| 23 | pollinations/community/iotserver24/kimi-k2.7-code-nitro |  | 25,457 | 0 |  | last |
| 24 | openai/gpt-5.5-pro-2026-04-23 | PAID | 24,794 | 86 |  | last |
| 25 | aihubmix/gpt-5.4 | PAID | 24,076 | 11 |  | earlier |

**25 highest and 25 lowest tokens/s** (routes with a measurable tokens/s and >= 20 output tokens, which removes the noisy short answers; these are streamed by construction):

| # | fastest tok/s route | tok/s | TTFT ms | out | slowest tok/s route | tok/s | TTFT ms | out |
|---|---|---|---|---|---|---|---|---|
| 1 | nousresearch/qwen/qwen3.6-27b | 463.0 | 5,620 | 83 | huggingface/google/gemma-3-27b-it | 6.0 | 7,575 | 38 |
| 2 | aihubmix/qwen3.6-max-preview | 336.4 | 9,571 | 346 | nousresearch/openai/gpt-6-astra-fast | 7.2 | 9,356 | 41 |
| 3 | aihubmix/qwen3.5-397b-a17b | 319.2 | 22,147 | 847 | infron/z-ai/glm-4.6v | 7.6 | 7,805 | 96 |
| 4 | openrouter/z-ai/glm-4.7-flash | 309.5 | 6,158 | 96 | aihubmix/deepseek-v4-pro | 7.9 | 9,712 | 58 |
| 5 | openrouter/qwen/qwen3-vl-30b-a3b-thinking | 302.4 | 8,148 | 268 | nousresearch/openai/gpt-5.1-codex-max | 8.0 | 9,038 | 64 |
| 6 | aihubmix/qwen3-next-80b-a3b-thinking | 276.9 | 7,264 | 1963 | nvidia/nvidia/ising-calibration-1.5-31b | 8.5 | 12,016 | 31 |
| 7 | openrouter/qwen/qwen3-next-80b-a3b-thinking | 240.4 | 8,895 | 1963 | alibaba/qwen3.8-max-0902 | 10.1 | 7,808 | 127 |
| 8 | infron/bytedance/seed-2.0-mini | 218.8 | 6,233 | 576 | nousresearch/openai/gpt-5 | 10.7 | 8,244 | 64 |
| 9 | infron/qwen/qwen3-next-80b-a3b-thinking | 218.2 | 8,985 | 1963 | nousresearch/openai/gpt-5.5-pro | 11.1 | 7,526 | 49 |
| 10 | alibaba/qwen3-next-80b-a3b-thinking | 198.7 | 3,787 | 1963 | nousresearch/openai/gpt-5.1-codex-mini | 11.2 | 7,197 | 83 |
| 11 | alibaba/qwen3.5-35b-a3b | 187.8 | 2,919 | 5327 | kilo/qwen/qwen3.8-27b:free | 11.9 | 10,608 | 96 |
| 12 | alibaba/qwen3.7-max-preview | 187.3 | 8,419 | 852 | infron/stepfun/step-3.5-flash | 12.0 | 5,554 | 96 |
| 13 | kiraai/kira-mini-1.0 | 183.5 | 16,244 | 760 | aihubmix/nemotron-3.5-lightning-free | 12.1 | 7,244 | 96 |
| 14 | infron/volcengine/doubao-seed-2.0-mini | 182.7 | 6,272 | 828 | aihubmix/gemini-2.5-pro-preview-05-06 | 13.0 | 7,365 | 92 |
| 15 | alibaba/qwen3.6-flash | 176.5 | 5,290 | 4165 | huggingface/microsoft/phi-4 | 13.2 | 11,017 | 46 |
| 16 | aihubmix/minimax-m2.5 | 170.7 | 10,072 | 787 | nousresearch/nvidia/nemotron-3-nano-30b-a3b | 13.5 | 7,344 | 96 |
| 17 | tokenharbor/deepseek-v4-flash:free | 167.0 | 6,982 | 151 | aihubmix/glm-5.2-fast-preview | 13.7 | 7,633 | 97 |
| 18 | alibaba/qwen3.6-flash-2026-04-16 | 166.1 | 6,379 | 4258 | infron/z-ai/glm-4.7-flash | 15.1 | 7,057 | 96 |
| 19 | nousresearch/x-ai/grok-4.3 | 162.8 | 9,223 | 592 | infron/openai/gpt-oss-120b | 15.4 | 9,942 | 27 |
| 20 | aihubmix/doubao-seed-2-0-mini-260428 | 162.5 | 6,103 | 285 | cloudflare/@cf/meta-llama/llama-2-7b-chat-hf-lora | 15.5 | 6,183 | 96 |
| 21 | openrouter/x-ai/grok-4.6 | 162.1 | 18,364 | 598 | aihubmix/intern-s2-free | 15.8 | 10,244 | 96 |
| 22 | alibaba/qwen3.6-35b-a3b | 160.8 | 4,845 | 3938 | nousresearch/qwen/qwen3-32b | 16.4 | 16,434 | 96 |
| 23 | alibaba/qwen3.7-max-2026-05-17 | 156.1 | 5,670 | 1451 | nousresearch/qwen/qwen3.5-flash-02-23 | 16.7 | 8,106 | 96 |
| 24 | aihubmix/qwen3.5-flash | 152.0 | 9,687 | 2854 | huggingface/Qwen/Qwen3-4B-Thinking-2507 | 17.3 | 5,271 | 96 |
| 25 | alibaba/qwen3.5-27b | 151.7 | 7,583 | 616 | hcnsec/Qwen3.8-27B | 17.3 | 11,314 | 90 |

**Per provider** (providers with >= 5 ok routes; streamed and burst reported separately; "legacy share" = share of that provider's ok records that come from the earlier, faster-looking records):

| provider | ok routes | streamed n | TTFT median (streamed) ms | burst n | whole-answer median (burst) ms | legacy share | tok/s n | tok/s median |
|---|---|---|---|---|---|---|---|---|
| nousresearch | 288 | 41 | 7,407 | 247 | 10,635 | 60.1% | 40 | 35.8 |
| aihubmix | 272 | 69 | 7,633 | 203 | 10,934 | 84.2% | 66 | 49.1 |
| infron | 253 | 46 | 7,501 | 207 | 8,761 | 100.0% | 44 | 45.3 |
| openrouter | 236 | 57 | 7,198 | 179 | 7,249 | 97.5% | 52 | 38.8 |
| huggingface | 123 | 26 | 7,161 | 97 | 8,133 | 98.4% | 25 | 22.3 |
| alibaba | 107 | 41 | 7,084 | 66 | 7,173 | 100.0% | 41 | 71.0 |
| pollinations | 106 | 0 | - | 106 | 9,663 | 37.7% | 0 | - |
| anymodel | 68 | 9 | 10,825 | 59 | 11,764 | 95.6% | 6 | 41.8 |
| xkiro | 53 | 12 | 8,541 | 41 | 10,435 | 50.9% | 6 | 31.9 |
| openai | 46 | 2 | 4,144 | 44 | 11,617 | 0.0% | 1 | 12.8 |
| nscale | 21 | 1 | 6,214 | 20 | 8,022 | 100.0% | 1 | 18.5 |
| mistral | 20 | 2 | 12,549 | 18 | 9,393 | 0.0% | 2 | 1.4 |
| cohere | 18 | 0 | - | 18 | 6,166 | 100.0% | 0 | - |
| cloudflare | 17 | 3 | 6,183 | 14 | 7,670 | 100.0% | 1 | 15.5 |
| anthropic | 13 | 1 | 9,387 | 12 | 7,319 | 100.0% | 1 | 4.3 |
| hcnsec | 12 | 5 | 11,314 | 7 | 8,325 | 91.7% | 4 | 33.0 |
| bigmodel | 11 | 6 | 9,249 | 5 | 11,027 | 100.0% | 6 | 31.6 |
| experientiallabs | 10 | 0 | - | 10 | 10,567 | 0.0% | 0 | - |
| nararouter | 10 | 1 | 3,973 | 9 | 10,136 | 10.0% | 1 | 4.7 |
| google | 9 | 0 | - | 9 | 11,140 | 100.0% | 0 | - |
| nvidia | 9 | 2 | 18,598 | 7 | 7,245 | 100.0% | 2 | 15.1 |
| tokenharbor | 9 | 3 | 5,721 | 6 | 7,797 | 66.7% | 3 | 33.8 |
| kilo | 7 | 1 | 10,608 | 6 | 8,753 | 42.9% | 1 | 11.9 |
| zenmux | 6 | 2 | 11,786 | 4 | 11,093 | 33.3% | 2 | 29.4 |
| ollama | 6 | 1 | 4,543 | 5 | 7,471 | 100.0% | 1 | 103.6 |
| fanar | 6 | 1 | 10,773 | 5 | 7,202 | 100.0% | 0 | - |
| vyceai | 6 | 1 | 23,816 | 5 | 12,493 | 100.0% | 1 | 45.8 |
| aionlabs | 6 | 2 | 5,779 | 4 | 8,832 | 100.0% | 2 | 51.0 |
| llm7 | 5 | 0 | - | 5 | 7,164 | 20.0% | 0 | - |
| groq | 5 | 0 | - | 5 | 8,221 | 100.0% | 0 | - |


### 2.4 `empty`: answered, no visible text (76 of 5,794 eligible routes) - its own group

`empty` is neither "works" nor "does not work": the provider answered a 200 stream and no text came back within 96 tokens. It is counted here and only here; sec 0 and sec 3 refer to it.

| Cause | Routes | Would a bigger max_tokens likely help? |
|---|---|---|
| budget spent on hidden reasoning (stop_reason max_tokens, o > 0) | 55 | **Likely yes** (55 routes, 33 of them flagged `reason` in the snapshot; 25 of all 76 empty routes report exactly 64 output tokens although the request said 96, mostly openai reasoning ids, so some upstream or the gateway enforces a lower effective cap; not explained here; 29 of the 55 are legacy records) |
| stream ended with no content (stop_reason end_turn) | 2 | No: the model finished with nothing to say; likely non-chat or filtered |
| legacy record, no message | 19 | Unknown: 8 have output_tokens 0/null (likely non-chat: alibaba/qwen3-asr-flash, gemini-3-pro-image), 11 reported tokens (probably hidden reasoning); re-probe |

By provider (routes): aihubmix 20, openai 16, infron 12, nousresearch 8, kiraai 7, openrouter 3, cloudflare 3, bluesminds 2, inceptionlabs 2, alibaba 1, nvidia 1, anymodel 1. 24 of the 76 empty routes have the same model id answering `ok` at another provider. Suggested: re-probe the 55 with max_tokens 1024 under the sweep's spend cap (bill-bearing; not priced here). `empty` means the provider answered, so it must not be pruned.

## 3. What does not answer, by cause

Population: the **3,931 routes that did not answer** (67.8% of 5,794); `empty` (76) is excluded here (sec 2.4). Clusters come from `m` (the provider's own sentence, up to 160 characters) and, for the 879 legacy non-ok routes that lack `m`, from `p` (40 characters: a truncated sentence, so the rules match prefixes on purpose). Rules are in `scripts/clusters.mjs` (sec 6 lists the ones changed after review); 6 routes remain in `*:other`. Provenance mix: L listing-verified, C catalogue-only, A config-asserted (as stored; see sec 2.1 for google's normalisation artefact). Legacy = the record predates the last run.

### 3.1 pay (1,972 routes = 34.0% of 5,794 eligible)

| Cause cluster | Routes | % of the 3,931 that did not answer | legacy | Provenance | Top providers | Examples |
|---|---|---|---|---|---|---|
| `pay:insufficient-balance` | 1,026 | 26.1% | 95 | L 923 / C 102 / A 1 | kilo 359, orcarouter 160, openrouter 119 | `openrouter/aion-3.0`<br>`aihubmix/agnes-2.5-pro`<br>`kilo/aion-2.0` |
| `pay:model-locked-until-purchase` | 267 | 6.8% | 10 | L 267 / C 0 / A 0 | experientiallabs 267 | `experientiallabs/aion-2.0`<br>`experientiallabs/aion-3.0`<br>`experientiallabs/aion-3.0-mini` |
| `pay:402-opaque-upstream-message` | 196 | 5.0% | 24 | L 195 / C 0 / A 1 | veniceai 114, gmicloudai 66, chutes 14 | `huggingface/prism-ml/Ternary-Bonsai-27B-gguf`<br>`veniceai/gemini-3-6-flash`<br>`gmicloudai/google/gemini-3.8-flash` |
| `pay:gift-or-promo-balance-cannot-cover-model` | 185 | 4.7% | 1 | L 185 / C 0 / A 0 | tokenrouter 130, xkiro 53, teamorouter 2 | `tokenrouter/openai/gpt-5.4-nano`<br>`xkiro/anthropic/claude-fable-5`<br>`teamorouter/deepseek-flash` |
| `pay:model-needs-minimum-balance` | 143 | 3.6% | 9 | L 143 / C 0 / A 0 | zenmux 143 | `zenmux/ernie-5.0-thinking-preview`<br>`zenmux/mimo-v2.5`<br>`zenmux/mimo-v2.5-pro` |
| `pay:plan-or-premium-gated` | 137 | 3.5% | 36 | L 137 / C 0 / A 0 | commandcode 63, bai 33, xkiro 18 | `aihubmix/qwen3.8-max-preview`<br>`xkiro/openai/gpt-6-luna`<br>`commandcode/gpt-6-astra` |
| `pay:daily-check-in-required` | 17 | 0.4% | 3 | L 17 / C 0 / A 0 | apinex 17 | `apinex/free/claude-opus-4.6`<br>`apinex/free/claude-sonnet-4.6`<br>`apinex/free/deepseek-v4-flash-0731` |
| `pay:MISCLASSIFIED-realtime-model(not-a-balance-issue)` | 1 | 0.0% | 1 | L 1 / C 0 / A 0 | alibaba 1 | `alibaba/qwen3-s2s-flash-realtime` |

### 3.2 auth (88 routes = 1.5% of 5,794 eligible)

| Cause cluster | Routes | % of the 3,931 that did not answer | legacy | Provenance | Top providers | Examples |
|---|---|---|---|---|---|---|
| `auth:access-denied(alibaba-region-or-model)` | 22 | 0.6% | 17 | L 6 / C 16 / A 0 | alibaba 17, aihubmix 5 | `alibaba/qwen-max-2025-01-25`<br>`aihubmix/qwen-turbo-latest`<br>`alibaba/qwen-max-latest` |
| `auth:client-restricted` | 17 | 0.4% | 4 | L 16 / C 0 / A 1 | opencode 12, agentrouter 4, vyceai 1 | `opencode/big-pickle`<br>`vyceai/qwen3.8-flash`<br>`agentrouter/gpt-5.6-sol` |
| `auth:plan-or-consent-restricted-model` | 15 | 0.4% | 6 | L 9 / C 6 / A 0 | openrouter 6, mistral 6, xkiro 2 | `openrouter/inkling-small:free`<br>`mistral/glm-5-2`<br>`xkiro/anthropic/claude-fable-5-1` |
| `auth:aggregator-model-access-denied-or-offline` | 14 | 0.4% | 5 | L 14 / C 0 / A 0 | aihubmix 14 | `aihubmix/DeepSeek-V3.1-Think`<br>`aihubmix/qwen3-max-2026-01-23`<br>`aihubmix/kimi-k2-0711` |
| `auth:opaque-upstream-message` | 10 | 0.3% | 10 | L 9 / C 0 / A 1 | cloudflare 8, kktoken 1, justdowork 1 | `cloudflare/@cf/moonshotai/kimi-k2.7-code`<br>`kktoken/gpt-4o-mini`<br>`justdowork/claude-opus-4-8` |
| `auth:bad-or-inactive-key` | 8 | 0.2% | 4 | L 7 / C 0 / A 1 | sambanova 7, indeedwebid 1 | `sambanova/gemma-4-31b-it`<br>`indeedwebid/ineed/freetier`<br>`sambanova/DeepSeek-V3.1` |
| `auth:model-opt-in-required(Labs)` | 2 | 0.1% | 1 | L 2 / C 0 / A 0 | mistral 2 | `mistral/labs-leanstral-1-5`<br>`mistral/labs-leanstral-1-5-1` |

### 3.3 gone (1,138 routes = 19.6% of 5,794 eligible)

| Cause cluster | Routes | % of the 3,931 that did not answer | legacy | Provenance | Top providers | Examples |
|---|---|---|---|---|---|---|
| `gone:model-does-not-exist` | 247 | 6.3% | 238 | L 22 / C 224 / A 1 | alibaba 221, kilo 13, huggingface 8 | `alibaba/glm-5`<br>`infron/holo/holo3-35b-a3b`<br>`aihubmix/cohere-command-a` |
| `gone:does-not-exist-OR-no-access(ambiguous)` | 207 | 5.3% | 9 | L 34 / C 173 / A 0 | openai 199, aihubmix 3, cerebras 3 | `aihubmix/gpt-4o-audio-preview`<br>`openai/chatgpt-4o-latest`<br>`groq/compound` |
| `gone:batch-variant-not-chat` | 172 | 4.4% | 87 | L 125 / C 47 / A 0 | openrouter 64, nousresearch 63, openai 35 | `openrouter/inkling:batch`<br>`nousresearch/anthropic/claude-sonnet-5.5:batch`<br>`openai/gpt-3.5-turbo:batch` |
| `gone:invalid-or-unsupported-model-name` | 171 | 4.4% | 9 | L 27 / C 143 / A 1 | mistral 144, zenmux 16, aihubmix 7 | `openrouter/virtuoso-large`<br>`alibaba/qwen-omni-turbo-realtime`<br>`aihubmix/coding-xiaomi-mimo-v2-omni` |
| `gone:404-opaque-upstream-message` | 96 | 2.4% | 90 | L 66 / C 29 / A 1 | nvidia 91, cloudflare 3, gmicloudai 2 | `nvidia/deepseek-ai/deepseek-v4-flash-0731`<br>`gmicloudai/inclusionAI/Ling-3.0-flash-fin`<br>`cloudflare/gemma-sea-lion-v4-27b-it` |
| `gone:google-models-prefix(not-found-OR-not-supported-for-generateContent)` | 95 | 2.4% | 95 | L 8 / C 87 / A 0 | google 95 | `google/diffusiongemma-26b-a4b-it`<br>`google/flan-t5-xl-3b`<br>`google/gemini-2-5-flash` |
| `gone:non-chat-by-message` | 49 | 1.2% | 0 | L 49 / C 0 / A 0 | zenmux 26, openai 23 | `openai/gpt-4o-mini-search-preview`<br>`zenmux/inclusionai/ming-image-0.1-design`<br>`openai/gpt-4o-mini-search-preview-2025-03-11` |
| `gone:no-endpoints-or-unavailable` | 27 | 0.7% | 23 | L 12 / C 14 / A 1 | openrouter 19, anymodel 5, aihubmix 2 | `openrouter/auto-beta`<br>`aihubmix/ling-3.0-tiny-free`<br>`orcarouter/auto` |
| `gone:decommissioned-or-deprecated` | 23 | 0.6% | 8 | L 15 / C 8 / A 0 | bluesminds 8, aihubmix 5, cohere 5 | `openrouter/openai/gpt-5.2-chat`<br>`aihubmix/gpt-4o-search-preview`<br>`nousresearch/meituan/longcat-2.0:free` |
| `gone:model-not-found` | 18 | 0.5% | 18 | L 2 / C 15 / A 1 | ollama 12, cohere 3, aihubmix 1 | `aihubmix/gemini-2.5-flash-preview-09-2025`<br>`cohere/command-a`<br>`apinex/gpt/5.6-sol` |
| `gone:404-provider-not-found(no-detail)` | 8 | 0.2% | 8 | L 8 / C 0 / A 0 | infron 8 | `infron/inclusionai/ling-2.6-1t`<br>`infron/rednote-hilab/dots.ocr`<br>`infron/inclusionai/ling-2.6-flash` |
| `gone:no-longer-available-to-new-users(account-state)` | 8 | 0.2% | 8 | L 0 / C 8 / A 0 | google 8 | `google/gemini-2.0-flash`<br>`google/gemini-2.0-flash-001`<br>`google/gemini-2.0-flash-lite` |
| `gone:other` | 6 | 0.2% | 6 | L 3 / C 3 / A 0 | hcnsec 3, ollama 2, cohere 1 | `cohere/c4ai-aya-expanse-8b`<br>`ollama/internlm2-5-20b-chat`<br>`hcnsec/Qwen3-Embedding-8B` |
| `gone:not-found(generic)` | 4 | 0.1% | 2 | L 4 / C 0 / A 0 | nousresearch 4 | `nousresearch/openai/gpt-5.2-chat`<br>`nousresearch/amazon/nova-premier-v1`<br>`nousresearch/inclusionai/ling-3.0-flash-fin:free` |
| `gone:not-a-chat-model(may-be-Responses-API-only)` | 3 | 0.1% | 3 | L 3 / C 0 / A 0 | aihubmix 3 | `aihubmix/gpt-5.5-pro`<br>`aihubmix/gpt-5.2-pro`<br>`aihubmix/o3-pro` |
| `gone:unspecific-message` | 2 | 0.1% | 1 | L 2 / C 0 / A 0 | openrouter 1, aihubmix 1 | `openrouter/openai/gpt-3.5-turbo-instruct`<br>`aihubmix/claude-3-haiku-20240307` |
| `gone:no-channel-for-account-group(entitlement)` | 2 | 0.1% | 0 | L 0 / C 0 / A 2 | tokenrouter 1, kiosapi 1 | `tokenrouter/qwen/qwen3.8-max-free`<br>`kiosapi/deepseek-v4.1-flash-free` |

### 3.4 error (619 routes = 10.7% of 5,794 eligible)

| Cause cluster | Routes | % of the 3,931 that did not answer | legacy | Provenance | Top providers | Examples |
|---|---|---|---|---|---|---|
| `error:fetch-failed(gateway/local-network)` | 270 | 6.9% | 0 | L 244 / C 26 / A 0 | infron 34, kilo 24, experientiallabs 19 | `openrouter/z-ai/glm-5.3-prime`<br>`alibaba/qwen-plus-2025-07-14`<br>`infron/openai/gpt-4o-mini-transcribe/audio-to-text` |
| `error:non-chat-by-message` | 149 | 3.8% | 0 | L 139 / C 10 / A 0 | infron 86, alibaba 23, google 11 | `alibaba/qwen3-omni-flash-realtime`<br>`infron/openai/gpt-4o-transcribe/audio-to-text`<br>`experientiallabs/jev-latest` |
| `error:model-unavailable-or-not-served` | 82 | 2.1% | 0 | L 67 / C 14 / A 1 | aihubmix 50, opencode 15, infron 10 | `infron/kwaipilot/kat-coder-pro-v2`<br>`aihubmix/hy3-preview`<br>`huggingface/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4` |
| `error:non-chat-by-id(message-uninformative)` | 40 | 1.0% | 0 | L 40 / C 0 / A 0 | alibaba 22, cloudflare 8, nousresearch 6 | `alibaba/qwen-image-3.0-pro`<br>`aihubmix/gpt-4o-mini-audio-preview`<br>`nousresearch/voyageai/voyage-4-lite` |
| `error:upstream-overloaded-or-transient-5xx` | 26 | 0.7% | 0 | L 22 / C 3 / A 1 | seekai 11, alibaba 6, google 4 | `alibaba/qwen3-tts-vd-realtime-2025-12-16`<br>`google/gemini-3.5-flash`<br>`xkiro/deepseek/deepseek-v4-flash-0731` |
| `error:opaque-upstream-failure` | 23 | 0.6% | 0 | L 21 / C 0 / A 2 | cloudflare 16, fanar 4, gmicloudai 1 | `gmicloudai/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16`<br>`cloudflare/@cf/pipecat-ai/smart-turn-v2`<br>`fanar/Fanar-Shaheen-MT-1` |
| `error:model-rejects-request-shape` | 17 | 0.4% | 0 | L 16 / C 0 / A 1 | nousresearch 14, aihubmix 1, nararouter 1 | `aihubmix/aihubmix-router`<br>`nousresearch/upstage/solar-pro4:free`<br>`nararouter/jev` |
| `error:chat-needs-other-route` | 9 | 0.2% | 0 | L 7 / C 2 / A 0 | commandcode 7, google 2 | `google/antigravity-preview-05-2026`<br>`commandcode/claude-sonnet-5-5`<br>`google/antigravity-preview-09-2026` |
| `error:no-text-output(non-chat-or-budget)` | 1 | 0.0% | 0 | L 1 / C 0 / A 0 | alibaba 1 | `alibaba/qwen3-32b` |
| `error:chat-entitlement(product-not-activated)` | 1 | 0.0% | 0 | L 1 / C 0 / A 0 | alibaba 1 | `alibaba/kimi/kimi-k3` |
| `error:chat-no-streaming` | 1 | 0.0% | 0 | L 1 / C 0 / A 0 | infron 1 | `infron/openai/gpt-5.5-pro` |

### 3.5 rate (72 routes = 1.2% of 5,794 eligible)

| Cause cluster | Routes | % of the 3,931 that did not answer | legacy | Provenance | Top providers | Examples |
|---|---|---|---|---|---|---|
| `rate:rate-limited(momentary)` | 28 | 0.7% | 0 | L 18 / C 10 / A 0 | mistral 21, aihubmix 6, nousresearch 1 | `aihubmix/coding-xiaomi-mimo-v2.5`<br>`nousresearch/mistralai/mistral-large-2512`<br>`mistral/devstral-2512` |
| `rate:quota-exhausted(free-tier-or-daily)` | 19 | 0.5% | 0 | L 10 / C 9 / A 0 | google 17, aihubmix 2 | `aihubmix/xiaomi-mimo-v2-omni-free`<br>`google/deep-research-max-preview-04-2026`<br>`aihubmix/mimo-v2-flash-free` |
| `rate:MISCLASSIFIED-really-pay(insufficient-credits)` | 18 | 0.5% | 0 | L 18 / C 0 / A 0 | nararouter 18 | `nararouter/claude-fable-5.1`<br>`nararouter/claude-sonnet-5`<br>`nararouter/deepseek-v4-flash-alibaba` |
| `rate:MISCLASSIFIED-free-access-not-enabled(account-gate)` | 5 | 0.1% | 0 | L 5 / C 0 / A 0 | orcarouter 5 | `orcarouter/orcarouter/free`<br>`orcarouter/deepseek/deepseek-v4-flash-free`<br>`orcarouter/tencent/hy3-free` |
| `rate:provider-error(unspecific)` | 2 | 0.1% | 0 | L 2 / C 0 / A 0 | openrouter 1, aihubmix 1 | `openrouter/google/gemma-4-31b-it:free`<br>`aihubmix/qwen3.8-27b` |

### 3.6 timeout (42 routes = 0.7% of 5,794 eligible)

| Cause cluster | Routes | % of the 3,931 that did not answer | legacy | Provenance | Top providers | Examples |
|---|---|---|---|---|---|---|
| `timeout:no-complete-answer-in-35s` | 42 | 1.1% | 0 | L 41 / C 1 / A 0 | nvidia 8, aihubmix 7, infron 6 | `openrouter/nemotron-3.5-lightning:free`<br>`alibaba/qwen3-vl-32b-thinking`<br>`infron/qwen/qwen3-vl-235b-a22b-thinking` |

Cause sentences worth knowing: kilo "Add credits to continue, or switch to a free model"; zenmux "only available to accounts with a balance greater than ..."; tokenrouter "This model cannot use part of your gift balance"; commandcode "Your Go plan doesn't include API access"; xkiro "This premium model requires an active paid plan or real deposited balance"; apinex "Daily check-in required to use free models" (17 routes, all apinex free/* ids); opencode "OpenCode's free tier can only be used from within OpenCode" (an entitlement tied to the client); mistral "Model ... is a Labs model ... an admin must enable ..." (2 routes); openrouter "This model requires you to complete ... 18+ age confirmation"; nousresearch "Couldn't find that, sorry" (404 without detail; with the openrouter/openai `:batch` ids these are batch-API twins, see 3.7); openai "The requested model `x` ... does not exist or you do not have access to it" (207 routes: removal versus entitlement cannot be told apart; a truncated legacy prefix is treated the same way); google "models/x is not found for API version ..., or is not supported for generateContent" (95 routes) and "This model models/x is no longer available to new users" (8 routes: account state).

### 3.7 Non-chat and batch ids: the corrected split

Revision 1 hid 175 `gone` rows (":batch" and "not a chat model") and reclassified 161 `error` rows as non-chat, by id pattern and a regex cluster. The review found that hides working or reachable chat models: 4 of 177 `:batch` routes answer ok (openrouter/anthropic/claude-opus-5.5:batch, openrouter/anthropic/claude-opus-5:batch, nousresearch/anthropic/claude-opus-5.5:batch, nousresearch/anthropic/claude-opus-5:batch); the 3 aihubmix ids (aihubmix/gpt-5.5-pro, aihubmix/gpt-5.2-pro, aihubmix/o3-pro) are Responses-API chat models; and at least 12 of the 161 `error` rows are chat models (commandcode Claude ids "must be called via /provider/v1/messages", infron/gpt-5.5-pro "does not support streaming", alibaba/qwen3-32b "no text output" inside the budget, alibaba/kimi-k3 "product is not activated"). It also missed 49 `gone` rows whose sentence says non-chat outright (openai "not supported with the Responses API" 23, zenmux "not supported by /v1/chat/completions" 26) and about 55 non-chat ids sitting in the shape/opaque `error` buckets. The rule is now status- and message-conditional:

| Bucket (revision 2) | Routes | Decision | Evidence used |
|---|---|---|---|
| gone, provider sentence says non-chat (openai Responses API, zenmux /v1/chat/completions) | 49 | hide behind a filter (reversible) | the provider's own sentence |
| error, provider sentence says non-chat (audio/video/image/realtime model, `requires /v1/decisions`, `only allows access to the llm model`, ASR/TTS input errors) | 149 | hide behind a filter (reversible) | the provider's own sentence; by provider infron 86, alibaba 23, google 11, pollinations 7, agnes 6, llm7 5 |
| gone `:batch` id whose base id answers ok | 103 | hide behind a filter (an ok chat twin exists) | id + the ok twin |
| gone id that names a non-chat model (veo, embedding, rerank, guard, ocr, mamba...) with a not-found sentence | 12 | hide behind a filter; re-probe once; NOT 'gone' (the model may exist) | id token + sentence |
| error, uninformative sentence, id names a non-chat model | 40 | label `non-chat?`; re-probe once; reclassify outputKind only if it repeats | id only; by provider alibaba 22, cloudflare 8, nousresearch 6, aihubmix 1, nvidia 1, cohere 1 |
| gone `:batch` id with NO ok twin | 69 | label `batch-only`; keep | id |
| `:batch` routes that answer ok | 4 | keep (they work) | status ok |
| error, `must be called via /provider/v1/messages` (commandcode Claude ids) and google Interactions API | 9 | label `needs other route`; keep; probe through that route | the provider's own sentence |
| gone, `This is not a chat model and t(his endpoint ...)` (aihubmix gpt-5.5-pro, gpt-5.2-pro, o3-pro) | 3 | label `needs Responses API?`; do not hide | id (pro models are Responses-only) + truncated sentence |
| error, `does not support streaming` (infron gpt-5.5-pro) | 1 | label `no streaming`; re-probe non-streaming | the provider's own sentence |
| error, `product is not activated` (alibaba kimi-k3) | 1 | label `not activated`; keep (entitlement) | the provider's own sentence |
| error, `does not contain text output` on an id that names no non-chat model (alibaba qwen3-32b) | 1 | re-probe with a larger budget; do not hide | sentence + id |
| gone, google `no longer available to new users` / group entitlement (`No available channel ... under group`) | 10 | label `restricted (new users)` / `no channel for account`; keep (account state) | the provider's own sentence |

Total hidden: **313 routes** (198 by the provider's own sentence, 103 batch twins with an ok base id, 12 gone ids naming a non-chat model), against 336 in revision 1. `error` and `gone` stay state: a hide is a filter on a row that remains in the data.

### 3.8 Records that look misclassified

| Pattern | Routes | Providers | Why / consequence | Examples |
|---|---|---|---|---|
| rate -> really pay | 18 | nararouter 18 | 429 carrying 'Insufficient credits'; classifyHttp checks QUOTA before the status | `nararouter/claude-fable-5.1 / nararouter: Insufficient credits. Please top up your balance and try a`<br>`nararouter/claude-sonnet-5 / nararouter: Insufficient credits. Please top up your balance and try ag` |
| rate -> account gate | 5 | orcarouter 5 | orcarouter 'Free models are not available to this account yet' is an entitlement, not a rate limit | `orcarouter/orcarouter/free / orcarouter: Free models are not available to this account yet. They req`<br>`orcarouter/deepseek/deepseek-v4-flash-free / orcarouter: Free models are not available to this accou` |
| rate -> quota (state, not momentary) | 19 | google 17, aihubmix 2 | google 'exceeded your current quota' / aihubmix 'limit of the free model quota': a quota is state, retrying now will not help | `aihubmix/xiaomi-mimo-v2-omni-free / aihubmix: Sorry, you have reached the limit of the free model qu`<br>`aihubmix/mimo-v2-flash-free / aihubmix: Sorry, you have reached the limit of the free model quota. P` |
| error -> non-chat by the provider's own sentence (hide behind filter) | 149 | infron 86, alibaba 23, google 11, pollinations 7 | audio/video/image/realtime/decision/ASR/TTS models rejected on a chat request | `alibaba/qwen3-omni-flash-realtime / alibaba: OpenAI response does not contain text output, reasoning`<br>`alibaba/qwen3.8-omni-flash-realtime / alibaba: OpenAI response does not contain text output, reasoni` |
| error -> non-chat by id only (message uninformative: label 'non-chat?') | 40 | alibaba 22, cloudflare 8, nousresearch 6, aihubmix 1 | the sentence says nothing; only the id names a non-chat model | `alibaba/qwen-image-3.0-pro / alibaba: Input should be a valid list: input.messages.0.content`<br>`alibaba/qwen-image-3.0 / alibaba: Input should be a valid list: input.messages.0.content` |
| error -> chat model that needs another route / no streaming / not activated (label, never hide) | 11 | commandcode 7, google 2, alibaba 1, infron 1 | commandcode Claude ids via /provider/v1/messages, infron gpt-5.5-pro no streaming, alibaba kimi-k3 product not activated | `alibaba/kimi/kimi-k3 / alibaba: The product is not activated, please confirm that you have activated`<br>`infron/openai/gpt-5.5-pro / infron: model gpt-5.5-pro-2026-04-23 does not support streaming (request` |
| error -> no text output (chat model with no text inside the budget, or non-chat) | 1 | alibaba 1 | alibaba/google 'response does not contain text output': re-probe with a larger budget | `alibaba/qwen3-32b / alibaba: OpenAI response does not contain text output, reasoning output, or tool` |
| gone -> batch twin, base id ok (hide), or batch-only (label) | 172 | openrouter 64, nousresearch 63, openai 35, google 10 | :batch ids; 4 :batch routes answered ok and are NOT in this row (status ok) | `openrouter/inkling:batch / openrouter: No endpoints found for inkli`<br>`openrouter/nemotron-3-ultra-550b-a55b:batch / openrouter: No endpoints found for nemot` |
| gone -> non-chat by the provider's own sentence (openai Responses API, zenmux /v1/chat/completions) | 49 | zenmux 26, openai 23 | explicit non-chat text that used to read 'listed but 404' | `openai/gpt-4o-mini-search-preview / openai: The requested model 'gpt-4o-mini-search-preview' is not `<br>`openai/gpt-4o-mini-search-preview-2025-03-11 / openai: The requested model 'gpt-4o-mini-search-previ` |
| gone -> 'not a chat model' (aihubmix): Responses-API-only chat models | 3 | aihubmix 3 | gpt-5.5-pro, gpt-5.2-pro, o3-pro | `aihubmix/gpt-5.5-pro / aihubmix: This is not a chat model and t`<br>`aihubmix/gpt-5.2-pro / aihubmix: This is not a chat model and t` |
| gone -> google 'new users' restriction or group entitlement (account state) | 10 | google 8, tokenrouter 1, kiosapi 1 | state, not gone | `google/gemini-2.0-flash / google: This model models/gemini-2.0-fla`<br>`google/gemini-2.0-flash-001 / google: This model models/gemini-2.0-fla` |
| gone -> google `models/x` (not found OR not supported for generateContent) | 95 | google 95 | verdict not visible in the stored snippet; full sentence is ambiguous | `google/diffusiongemma-26b-a4b-it / google: models/diffusiongemma-26b-a4b-it`<br>`google/flan-t5-xl-3b / google: models/flan-t5-xl-3b is not foun` |
| pay -> non-chat (realtime) | 1 | alibaba 1 | alibaba qwen3-s2s-flash-realtime: 'There are no suitable clusters.' | `alibaba/qwen3-s2s-flash-realtime / alibaba: There are no suitable clusters.` |
| pay opaque (402 with 'Upstream request failed.') | 196 | veniceai 114, gmicloudai 66, chutes 14, huggingface 1 | status code says pay but the message says nothing: cause unverified (balance/plan/other) | `huggingface/prism-ml/Ternary-Bonsai-27B-gguf / huggingface: Upstream request failed.`<br>`veniceai/gemini-3-6-flash / veniceai: Upstream request failed.` |
| auth opaque ('Upstream request failed.' on 401/403) | 10 | cloudflare 8, kktoken 1, justdowork 1 | cloudflare/kktoken/justdowork: gateway hides the provider message | `cloudflare/@cf/moonshotai/kimi-k2.7-code / cloudflare: Upstream request failed.`<br>`cloudflare/@cf/zai-org/glm-5.3 / cloudflare: Upstream request failed.` |
| gone opaque (404 'Upstream request failed.') | 96 | nvidia 91, cloudflare 3, gmicloudai 2 | nvidia/cloudflare: 404 with no reason; NVIDIA lists these org-prefixed ids yet 404s them | `nvidia/deepseek-ai/deepseek-v4-flash-0731 / nvidia: Upstream request failed.`<br>`nvidia/active-speaker-detection / nvidia: Upstream request failed.` |
| auth -> really gone/no-access ('does not exist or you do not have access') | 14 | aihubmix 14 | aihubmix uses 401/403 for missing/offline/disabled models | `aihubmix/DeepSeek-V3.1-Think / aihubmix: The model does not exist or yo`<br>`aihubmix/qwen3-max-2026-01-23 / aihubmix: Model access denied. (tid: 202` |
| gone -> really no-access (openai 'does not exist or you do not have access') | 207 | openai 199, aihubmix 3, cerebras 3, groq 2 | ambiguous: could be an entitlement (auth-like) rather than removal | `aihubmix/gpt-4o-audio-preview / aihubmix: The model `gpt-4o-audio-previe`<br>`aihubmix/doubao-seed-1-6-lite / aihubmix: The model or endpoint doubao-seed-1-6-lite-251015 does not` |
| gone with an ok sibling in same provider (spelling/variant-suffix/prefix), excluding :batch twins | 59 | alibaba 26, openai 22, google 7, nousresearch 2 |  | `openrouter/nemotron-3-nano-30b-a3b:free / openrouter: No endpoints found for nemot`<br>`alibaba/qwen-plus-2025-07-28:thinking / alibaba: Model not exist.` |
| gone :batch twin of an ok model | 103 | nousresearch 59, openrouter 23, openai 18, google 3 | batch-API id, not a chat route | `openrouter/inkling:batch / openrouter: No endpoints found for inkli`<br>`openrouter/nemotron-3-ultra-550b-a55b:batch / openrouter: No endpoints found for nemot` |
| gone but the provider's own listing names the id | 340 | nousresearch 68, openrouter 64, openai 54, nvidia 54 | listing-verified yet 404: routing/entitlement, not removal | `openrouter/anthropic/claude-sonnet-5.5:batch / openrouter: anthropic/claude-sonnet-5.5:batch cannot `<br>`openrouter/openai/gpt-6-luna-pro:batch / openrouter: openai/gpt-6-luna-pro:batch cannot be used with` |
| error -> really gone (message says model unavailable/not served) | 82 | aihubmix 50, opencode 15, infron 10, cohere 6 | 'cannot be served at the moment', 'Model is unavailable', 'No available providers' | `infron/kwaipilot/kat-coder-pro-v2 / infron: bad response status code 400 (request id: 20260929133859`<br>`infron/qwen/tongyi-deepresearch-30b-a3b / infron: bad response status code 400 (request id: 20260929` |
| error 'fetch failed' (probe artefact, not model state) | 270 | infron 34, kilo 24, experientiallabs 19, aihubmix 18 | no HTTP response reached us: gateway/local network; present all run, densest 13:10-13:50Z | `openrouter/z-ai/glm-5.3-prime / fetch failed`<br>`openrouter/qwen/qwen3.8-max-prime / fetch failed` |
| timeout with first token (slow, not dead) | 15 | alibaba 5, aihubmix 5, infron 2, nousresearch 2 |  | `alibaba/qwen3-vl-32b-thinking / no complete answer within 35000 ms; first token at 20187 ms`<br>`alibaba/qwen3.6-plus / no complete answer within 35000 ms; first token at 15912 ms` |

Populations differ per row (they are cross-cuts, not partitions); each denominator is the named pattern. Two systematic issues behind most of them: (a) the classifier checks the message before the status (`QUOTA` runs first, so nararouter's 429 "Insufficient credits ... try again in a few minutes" becomes `rate`), and `gone` has no way to say "not a chat model"; (b) the gateway rewrites some provider errors into "Upstream request failed.", which erases the sentence the classifier relies on, so the status then comes from the HTTP code alone (veniceai 114, gmicloudai 66, chutes 14 as `pay`; nvidia 91 as `gone`; cloudflare 8 as `auth`): those 325 routes have a status but no cause.

## 4. Fixable and retrievable

### 4a. Re-probe (transient, artefact, or evidence too thin)

**The re-probe headline is 1,364 routes, not 609.** 609 is only the rows whose *primary* action is re-probe. The action column also asks for a re-probe on 519 rows that get a label (gone rows the provider lists, opaque 404s, google `models/`, `non-chat?`, ambiguous openai wording) and on 224 remove candidates that rest on a legacy record, plus 12 hidden rows to confirm. Split: 609 + 519 + 224 + 12 = 1,364 (23.5% of 5,794 eligible; revision 1 said 648, its own column implied 1,405).

| Bucket | Routes | Note |
|---|---|---|
| error: fetch failed (no HTTP response) | 270 | Most likely gateway/network, see evidence below. 30 providers, 24 refused in under 100 ms. Not verified against gateway logs. |
| error: model not served ("cannot be served at the moment. Check the model ID", "model is unavailable", "no available providers") | 82 | Was filed as overload in revision 1 (45 aihubmix rows moved here). Re-probe; label `not served (upstream)` only if it repeats. |
| error: upstream overloaded / transient 5xx | 26 | The genuine overloads: seekai "system disk overloaded" (11), a few alibaba/google/xkiro. Retry later. |
| error: opaque upstream failure / model rejects request shape | 40 | No cause recorded, or needs list content / other parameters; one retry, then label. |
| timeout | 42 | 15 of 42 had a first token before the 35 s deadline (slow, not dead): retry with a 90 s deadline. |
| rate (momentary) | 28 | mistral "Rate limit exceeded" (21), aihubmix upstream limits; retry with backoff. |
| empty (hidden reasoning) | 55 | Retry at max_tokens 1024 (sec 2.4). |
| legacy `gone` / `pay` / `auth` (old classifier, no `m`) | 831 | 605 gone + 179 pay + 47 auth: one current-engine pass gives them a full sentence before any removal. |

**`fetch failed` evidence.** 270 routes, all `s=error`, none in any other status. Time clustering: **13.6%** (173 of 1,270) of last-run records written 13:10-13:50Z are `fetch failed`, against **4.3%** (97 of 2,241) outside that window and **0.8%** (21 of 2,668) of sweep-1 real results (the reviewer counts 0.4% of 5,781 sweep-1 probes, which includes skipped rows in the denominator). Burst structure: **23 groups** of >= 4 `fetch failed` within 3 s across 3-6 different providers (largest 8 rows), what a connection stall looks like with 8 probes in flight. 24 were refused in under 100 ms. It cannot show: the run log carries no outage timestamps, so alignment of the 12 stalls with 13:10-13:50Z is inference; and the 4.3% background rate means not every `fetch failed` is the gateway. **Recommendation: re-probe the 270 routes; the result settles it** (an artefact resolves to ok or the row's true state).
Population for the transient rows: the 3,931 routes that did not answer plus 76 empty; the re-probe set is 1,364 routes (above). Pending rows: 0 (sec 1).

### 4b. Spelling, alias and route fixes (gone rows with a sibling)

Method: for each `gone` route, look in the same provider (snapshot ids union the provider's discovery listing) for a sibling id: org-prefixed (`org/x` for `x`), bare (`x` for `org/x`), punctuation/case (`qwen3-5-27b` ~ `qwen3.5-27b`), or suffix-stripped (`x:free`, `x:thinking`, `x@eu`, `x:batch` -> `x`). A sibling counts only if it is `ok` in the bench. The listing comparison in this report normalises google's `models/` prefix, the `[1m]` suffix and case (revision 1 was prefix-blind).

| Finding | Routes | Denominator |
|---|---|---|
| gone routes with any candidate sibling id | 344 | 30.2% of 1,138 gone routes |
| gone routes whose sibling answered ok | 162 | 14.2% of 1,138 gone routes |
|   of which `:batch` twins of an ok model (see 3.7: hide, not fix) | 103 | 63.6% of 162 |
|   of which variant suffix (`:free`, `:thinking`, `@eu`, `@us`) of an ok id | 33 | alibaba, openai, google; the provider serves the base id |
|   of which punctuation/case spelling duplicates (alibaba `qwen3-5-*`) | 26 | catalogue spelling duplicates of ok ids |
| **fixable (variant-suffix + spelling)** | 59 | 5.2% of 1,138 gone routes: by provider alibaba 26, openai 22, google 7, nousresearch 2, openrouter 1, cohere 1 |
| gone routes where the same model id answers ok at another provider | 180 | 15.8% of 1,138; informational (a different route, not a fix) |
| error routes with an ok sibling | 6 | of 619 error routes |

Aliases the sibling test does not catch (reviewer, hand-scanned): mistral ~25 (`ministral-3-{3b,8b,14b}-2512`, `magistral-*`, `codestral@latest`), google ~37 (`@eu/@us/-thinking` of listed ids), kilo 2 (`hy3:free` vs listed `tencent/hy3`). Removing those duplicates is harmless but they are better handled by aliasing, for reach.

**The nvidia bare-id claim, checked.** nvidia has 91 gone routes (of 111 probed); 36 of them are bare ids (no `org/`), and 7 have an org-prefixed sibling in NVIDIA's listing, but **0 of those siblings answered ok**, so the spelling theory recovers 0 nvidia routes. More telling: 54 of the 91 nvidia gone routes are ids that NVIDIA's own listing names, and 29 are catalogue-only; NVIDIA lists more models than it serves on this endpoint and answers 404 with the opaque "Upstream request failed". Only 9 of 111 nvidia routes answer.
**Where `gone` comes from, by provenance** (1,138 gone routes): catalogue-only 751 (66.0%), listing-verified 380 (33.4%), config-asserted 7 (as stored). With the listing check normalised, **340 gone routes are named by the provider's own listing** (the exact-id check found 333; the extra 7 are all google): nousresearch 68, openrouter 64, openai 54, nvidia 54, zenmux 26, aihubmix 24, mistral 14, infron 9. Those are `:batch` twins, non-chat ids, and entitlement-gated models, not removals.

Sample of fixable pairs (gone id -> ok sibling in the same provider):

| provider | gone id | ok sibling [match type] |
|---|---|---|
| openrouter | `nemotron-3-nano-30b-a3b:free` | `nemotron-3-nano-30b-a3b [suffix-stripped]` |
| alibaba | `qwen-plus-2025-07-28:thinking` | `qwen-plus-2025-07-28 [suffix-stripped]` |
| alibaba | `qwen3-5-122b-a10b` | `qwen3.5-122b-a10b [punctuation-or-case]` |
| alibaba | `qwen3-5-27b` | `qwen3.5-27b [punctuation-or-case]` |
| alibaba | `qwen3-5-35b-a3b` | `qwen3.5-35b-a3b [punctuation-or-case]` |
| alibaba | `qwen3-5-397b-a17b` | `qwen3.5-397b-a17b [punctuation-or-case]` |
| alibaba | `qwen3-5-plus` | `qwen3.5-plus [punctuation-or-case]` |
| alibaba | `qwen3-6-27b` | `qwen3.6-27b [punctuation-or-case]` |
| alibaba | `qwen3-6-35b-a3b` | `qwen3.6-35b-a3b [punctuation-or-case]` |
| alibaba | `qwen3-6-flash` | `qwen3.6-flash [punctuation-or-case]` |
| alibaba | `qwen3-6-max-preview` | `qwen3.6-max-preview [punctuation-or-case]` |
| alibaba | `qwen3-7-flash` | `qwen3.7-flash [punctuation-or-case]` |
| alibaba | `qwen3-7-max` | `qwen3.7-max [punctuation-or-case]` |
| alibaba | `qwen3-7-plus` | `qwen3.7-plus [punctuation-or-case]` |
| alibaba | `qwen3-8-27b` | `qwen3.8-27b [punctuation-or-case]` |
| alibaba | `qwen3-8-max` | `qwen3.8-max [punctuation-or-case]` |
| alibaba | `qwen3.5-122b-a10b:thinking` | `qwen3.5-122b-a10b [suffix-stripped]` |
| alibaba | `qwen3.5-27b:thinking` | `qwen3.5-27b [suffix-stripped]` |
| alibaba | `qwen3.5-35b-a3b:thinking` | `qwen3.5-35b-a3b [suffix-stripped]` |
| alibaba | `qwen3.5-397b-a17b:free` | `qwen3.5-397b-a17b [suffix-stripped]` |


### 4c. `empty` -> larger max_tokens

55 of 76 empty routes (72.4%) are recorded as budget-spent-on-hidden-reasoning: expected recoverable to `ok` at max_tokens >= 1024. 19 legacy empties (8 with no output tokens, likely non-chat) need a re-probe to know; 2 will not be helped. Upper bound of recovery: 55 routes = 0.9% of eligible.

### 4d. `auth` (88 routes)

| Cause | Routes | Fix |
|---|---|---|
| `auth:access-denied(alibaba-region-or-model)` | 22 | alibaba/aihubmix "Access denied" (DashScope): the account or region is not entitled to that model; contact provider or drop the id (17 legacy). Not a key problem: the same key answers 107 other alibaba routes. |
| `auth:client-restricted` | 17 | opencode free tier works only inside OpenCode; vyceai/agentrouter "unsupported/unauthorized client": cannot be fixed from here; label 'restricted client'. |
| `auth:plan-or-consent-restricted-model` | 15 | openrouter 18+ age confirmation (do once in the provider dashboard), mistral/xkiro plan limits. |
| `auth:aggregator-model-access-denied-or-offline` | 14 | aihubmix "model offline/disabled/no access" (14): provider-side; label, re-check monthly. |
| `auth:opaque-upstream-message` | 10 | cloudflare (8), kktoken, justdowork: the gateway hid the sentence; needs a direct probe to learn the cause. |
| `auth:bad-or-inactive-key` | 8 | **Check before replacing.** sambanova: 7 of 7 routes say "Incorrect API key" (stable at 10-11Z and 14Z) while its discovery call returned 200 with 7 models, so the listing call was accepted with some credential. Check (1) which credential the gateway sends for sambanova versus the vault key (the provider's masked fragment is in the raw sentence; compare its first and last characters with the vault entry), (2) make one direct call outside the sweep with the vault key. indeedwebid: 'Invalid or inactive API key' (discovery 401 too): that one is a key/account problem. |
| `auth:model-opt-in-required(Labs)` | 2 | mistral Labs models: an org admin must enable them in the Mistral console. |

By provider (routes): aihubmix 19, alibaba 17, opencode 12, mistral 8, cloudflare 8, sambanova 7, openrouter 6, agentrouter 4, xkiro 2, nararouter 1, vyceai 1, indeedwebid 1, kktoken 1, justdowork 1. Only the bad-key rows (8 of 88 auth routes) may be a credential problem; the rest are per-model entitlements.

### 4e. `pay`: who to fund, ranked by the models the provider actually names

Ranking is by **listing-named pay routes** (pay routes whose id the provider's own listing names, after normalisation): those are the models a top-up can plausibly unlock. The raw catalogue pay count is shown next to it. A payment gate often answers before a model-existence check, so catalogue-only pay rows may be `gone` behind the payment wall: deepseek has 94 pay routes but its listing names 2 models, so a top-up unlocks about 1. Conditional estimate = the provider's own ok share among its non-pay, non-`fetch failed` probed routes (sample size n shown), applied to its listing-named pay routes; **estimates with n < 30 are not shown**, because those non-pay rows are usually the free-tier survivors.

| # | provider | listing-named pay routes | catalogue pay routes | provider listing size | probed | ok now | cond. ok-rate of non-pay (n) | est. recoverable (n >= 30 only) | main pay cause | free-badged pay | shape |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | kilo | 350 | 359 | 395 | 403 | 7 | n=20: not estimated | - | insufficient-balance (359) | 2 | partial: some models already work |
| 2 | experientiallabs | 267 | 267 | 297 | 297 | 10 | n=11: not estimated | - | model-locked-until-purchase (267) | 0 | partial: some models already work |
| 3 | orcarouter | 160 | 160 | 205 | 180 | 2 | n=8: not estimated | - | insufficient-balance (160) | 0 | partial: some models already work |
| 4 | zenmux | 143 | 143 | 204 | 208 | 6 | 12.5% (n=48) | 18 | model-needs-minimum-balance (143) | 0 | partial: some models already work |
| 5 | tokenrouter | 133 | 133 | 149 | 142 | 3 | n=4: not estimated | - | gift-or-promo-balance-cannot-cover-model (130) | 1 | partial: some models already work |
| 6 | openrouter | 119 | 119 | 460 | 469 | 236 | 70.9% (n=333) | 84 | insufficient-balance (119) | 0 | partial: some models already work |
| 7 | veniceai | 114 | 114 | 126 | 126 | 3 | n=3: not estimated | - | 402-opaque-upstream-message (114) | 0 | partial: some models already work |
| 8 | xkiro | 71 | 71 | 132 | 132 | 53 | 89.8% (n=59) | 64 | gift-or-promo-balance-cannot-cover-model (53) | 4 | partial: some models already work |
| 9 | gmicloudai | 66 | 66 | 77 | 77 | 0 | n=3: not estimated | - | 402-opaque-upstream-message (66) | 0 | fully gated: nothing answers yet |
| 10 | commandcode | 63 | 63 | 84 | 84 | 2 | n=9: not estimated | - | plan-or-premium-gated (63) | 2 | partial: some models already work |
| 11 | opencode | 57 | 57 | 82 | 98 | 3 | 10.0% (n=30) | 6 | insufficient-balance (57) | 0 | partial: some models already work |
| 12 | tokenharbor | 53 | 53 | 63 | 63 | 9 | n=9: not estimated | - | insufficient-balance (53) | 0 | partial: some models already work |
| 13 | bai | 52 | 52 | 58 | 59 | 2 | n=4: not estimated | - | plan-or-premium-gated (33) | 0 | partial: some models already work |
| 14 | kiraai | 45 | 45 | 71 | 60 | 2 | n=9: not estimated | - | insufficient-balance (44) | 0 | partial: some models already work |
| 15 | llm7 | 39 | 39 | 61 | 49 | 5 | n=10: not estimated | - | insufficient-balance (39) | 0 | partial: some models already work |
| 16 | teamorouter | 35 | 35 | 46 | 46 | 2 | n=7: not estimated | - | insufficient-balance (33) | 3 | partial: some models already work |
| 17 | apinex | 28 | 28 | 35 | 34 | 2 | n=3: not estimated | - | daily-check-in-required (17) | 0 | partial: some models already work |
| 18 | pollinations | 15 | 15 | 142 | 131 | 106 | 93.8% (n=113) | 14 | insufficient-balance (15) | 0 | partial: some models already work |
| 19 | nararouter | 14 | 14 | 53 | 54 | 10 | 32.3% (n=31) | 5 | insufficient-balance (14) | 0 | partial: some models already work |
| 20 | chutes | 14 | 14 | 14 | 14 | 0 | n=0: not estimated | - | 402-opaque-upstream-message (14) | 0 | fully gated: nothing answers yet |
| 21 | routllm | 12 | 12 | 12 | 12 | 0 | n=0: not estimated | - | plan-or-premium-gated (7) | 0 | fully gated: nothing answers yet |
| 22 | ollama | 11 | 11 | 17 | 31 | 6 | n=20: not estimated | - | plan-or-premium-gated (11) | 0 | partial: some models already work |
| 23 | aihubmix | 3 | 3 | 417 | 424 | 272 | 67.5% (n=403) | 2 | insufficient-balance (2) | 0 | partial: some models already work |
| 24 | cerebras | 2 | 2 | 2 | 7 | 0 | n=5: not estimated | - | insufficient-balance (2) | 0 | fully gated: nothing answers yet |
| 25 | deepseek | 1 | 94 | 2 | 106 | 0 | n=0: not estimated | - | insufficient-balance (94) | 0 | fully gated: nothing answers yet |
| 26 | alibaba | 1 | 1 | 172 | 419 | 107 | 26.3% (n=407) | 0 | MISCLASSIFIED-realtime-model(not-a-balance-issue) (1) | 0 | partial: some models already work |
| 27 | huggingface | 1 | 1 | 132 | 134 | 123 | 93.2% (n=132) | 1 | 402-opaque-upstream-message (1) | 0 | partial: some models already work |
| 28 | xai | 1 | 1 | 0 | 1 | 0 | n=0: not estimated | - | 402-opaque-upstream-message (1) | 0 | fully gated: nothing answers yet |

Totals: 1,972 pay routes over 28 providers (1,870 named by a listing, 102 catalogue-only). Fully gated (0 ok): deepseek 1/94, gmicloudai 66/66, chutes 14/14, routllm 12/12, cerebras 2/2, xai 1/1 (listing-named/catalogue). Partially gated (free/other models still work): openrouter 119/469, pollinations 15/131, nararouter 14/54, ollama 11/31, aihubmix 3/424, alibaba 1/419, huggingface 1/134 (pay share < 50%). By badge, pay routes: (blank) 1,387, PAID 573, FREE? 12; **none carries the FREE badge, 12 carry FREE?** (kilo 2, xkiro 4, commandcode 2, teamorouter 3, tokenrouter 1): free-claimed models the provider refused for money reasons: fix the badge or the label, they are the most misleading rows in the picker.

Cause caveats: for veniceai (114), gmicloudai (66) and chutes (14) the pay status comes from a 402 whose sentence the gateway replaced with "Upstream request failed."; the cause (balance vs plan) is unverified but the status code says payment. deepseek's 94 pay rows all say "Insufficient Balance"; its 12 other rows are `fetch failed`.

### 4f. Providers: dead, needs money, partially alive

| provider | verdict | probed | status mix | dominant blocker | top sentences | what to do |
|---|---|---|---|---|---|---|
| seekai | dead | 12 | error 12 | error:upstream-overloaded-or-transient-5xx (11) | error: seekai: system disk overloaded (current: #.#%, threshold: #%)<br>error: fetch failed | provider outage ("system disk overloaded" 99%): re-probe in a day; keep |
| sambanova | dead | 7 | auth 7 | auth:bad-or-inactive-key (7) | auth: sambanova: Incorrect API key provided: [masked-key].<br>auth: sambanova: Incorrect API key provided: # | verify which credential the gateway sends before replacing the key (sec 4d) |
| tabiai | dead | 1 | error 1 | error:opaque-upstream-failure (1) | error: {"error":{"message":"tabiai: Upstream request failed.","target_ | discovery 522: provider down; re-probe later |
| gorouter | dead | 1 | error 1 | error:opaque-upstream-failure (1) | error: {"error":{"message":"gorouter: Upstream request failed.","targe | discovery 502: provider down; re-probe later |
| indeedwebid | dead | 1 | auth 1 | auth:bad-or-inactive-key (1) | auth: indeedwebid: Invalid or inactive API key | invalid/inactive key: replace or drop the provider |
| kiosapi | dead | 1 | gone 1 | gone:no-channel-for-account-group(entitlement) (1) | gone: kiosapi: No available channel for model deepseek-v#.#-flash-free | listing empty, its only row says "No available channel": label |
| kktoken | dead | 1 | auth 1 | auth:opaque-upstream-message (1) | auth: kktoken: Upstream request failed. | opaque 401: needs a direct call to learn why |
| justdowork | dead | 1 | auth 1 | auth:opaque-upstream-message (1) | auth: {"error":{"message":"justdowork: Upstrea | opaque 401 |
| deepseek | needs-money | 106 | pay 94, error 12 | pay:insufficient-balance (94) | error: fetch failed<br>pay: deepseek: Insufficient Balance (request_ | top up only if wanted: its listing names 2 models (sec 4e); re-probe the 12 fetch-failed rows |
| chutes | needs-money | 14 | pay 14 | pay:402-opaque-upstream-message (14) | pay: chutes: Upstream request failed. | top up (402, opaque) |
| routllm | needs-money | 12 | pay 12 | pay:plan-or-premium-gated (7) | pay: routllm: No credits remaining — top up to continue<br>pay: routllm: Model anthropic/claude-fable-#  | top up / plan ("No credits remaining") |
| xai | needs-money | 1 | pay 1 | pay:402-opaque-upstream-message (1) | pay: xai: Upstream request failed. | 1 route, 403 opaque: check key |
| gmicloudai | no-answer (mixed) | 77 | pay 66, gone 2, error 9 | pay:402-opaque-upstream-message (66) | pay: gmicloudai: Upstream request failed.<br>error: fetch failed | top up (402 opaque, 66) and re-probe 8 fetch-failed |
| cerebras | no-answer (mixed) | 7 | pay 2, gone 5 | gone:does-not-exist-OR-no-access(ambiguous) (3) | gone: cerebras: Model does not exist or you do<br>pay: cerebras: Payment required to access thi | some routes archived/unknown, 2 need payment: label |

Providers reading "dead" are almost all tiny: the 8 hold 25 eligible routes together (0.4% of 5,794). Excluding `fetch failed` moves deepseek (94 pay) from no-answer to needs-money; xai's only route is a 403 opaque. Two "healthy" verdicts deserve a note: aihubmix (272 ok of 424) and openrouter (236 of 469) answer *and* carry the largest blocks of gone/pay, i.e. their catalogue lists more than they serve. inceptionlabs (2 empty, 0 ok) answers but hides its reasoning: it is partially alive, not dead.

## 5. Label vs remove proposal

**Guardrails applied.** (1) Never remove a model that ever answered: checked against all three bench files (current, before-probe-all, first-sweep), status ok or empty: 0 of the 577 explicit-not-found catalogue-only routes ever answered (and 0 of all 1,138 gone routes did). **This check is much weaker than it looks:** all three files are from a single day (1 calendar day); 0 routes went from ok to non-ok between them; each remove candidate has exactly one probe time in practice (358 of 361 have one distinct probe time, 3 have an earlier `error` record, **0 have two independent `gone` probes**; the 224 "legacy" candidates are one record copied into three files); and compaction prunes records past the freshness window, which erases the only "ever answered" evidence. So the guardrail is a same-day snapshot, not a history. **Before any automated removal:** keep a persistent ever-ok ledger (a model that has ever answered on any day is never removed) and require two independent `gone` probes on different days. (2) `pay`, `auth`, `rate`, `timeout`, `error`, `empty` are STATE: label or re-probe, never remove. (3) Removal only for `gone` with an explicit not-found/removed sentence visible in the stored text, catalogue-only provenance and not named by the listing after normalisation, no ok sibling, not a `:batch` id, id not naming a non-chat model, not the ambiguous "does not exist or you do not have access" wording. (4) A label that cannot be kept fresh should come down: the picker stops showing a record as current after 14 days (`BENCH_FRESH_MS`: the legacy records from 2026-10-13T10:26Z, the last run's from 2026-10-13T12:43Z), while a default re-probe uses the 7-day ttl (from 2026-10-06T10:26Z); without a scheduled re-sweep every label here silently disappears (the safe direction, but the work is lost).

**Action definitions.** keep = leave as is; label = keep in the picker with a state label; hide = behind a filter (non-chat / duplicate); remove = drop from the picker list; re-probe first = do not decide yet; fix first = a catalogue fix removes the problem.

| Cause bucket | Routes | % of eligible | Provenance (as stored) | Ever ok/empty in a bench file | Action classes (routes) | Label text (if labelled) | Risk / reversal |
|---|---|---|---|---|---|---|---|
| `auth:access-denied(alibaba-region-or-model)` | 22 | 0.4% | L 6 / C 16 / A 0 | 0 | label 22 | `access denied` | per-model entitlement; label is state |
| `auth:client-restricted` | 17 | 0.3% | L 16 / C 0 / A 1 | 0 | label 17 | `restricted client` | per-model entitlement; label is state |
| `auth:plan-or-consent-restricted-model` | 15 | 0.3% | L 9 / C 6 / A 0 | 0 | label 15 | `plan/consent required` | per-model entitlement; label is state |
| `auth:aggregator-model-access-denied-or-offline` | 14 | 0.2% | L 14 / C 0 / A 0 | 0 | label 14 | `no access/offline` | per-model entitlement; label is state |
| `auth:opaque-upstream-message` | 10 | 0.2% | L 9 / C 0 / A 1 | 0 | label 10 | `auth? (opaque)` | per-model entitlement; label is state |
| `auth:bad-or-inactive-key` | 8 | 0.1% | L 7 / C 0 / A 1 | 0 | label 8 | `bad key` | verify the credential before replacing it |
| `auth:model-opt-in-required(Labs)` | 2 | 0.0% | L 2 / C 0 / A 0 | 0 | label 2 | `opt-in required` | per-model entitlement; label is state |
| `empty:budget-spent-on-hidden-reasoning` | 55 | 0.9% | L 55 / C 0 / A 0 | 55 | re-probe first 55 |  | answered (empty): must not be pruned |
| `empty:legacy-no-message` | 19 | 0.3% | L 18 / C 1 / A 0 | 19 | re-probe first 19 |  | answered (empty): must not be pruned |
| `empty:stream-ended-no-content` | 2 | 0.0% | L 2 / C 0 / A 0 | 2 | re-probe first 2 |  | answered (empty): must not be pruned |
| `error:fetch-failed(gateway/local-network)` | 270 | 4.7% | L 244 / C 26 / A 0 | 0 | re-probe first 270 |  | no label: would blame the model for a gateway fault |
| `error:non-chat-by-message` | 149 | 2.6% | L 139 / C 10 / A 0 | 0 | hide 149 |  | a label is wrong if the row was only transient: re-probe first |
| `error:model-unavailable-or-not-served` | 82 | 1.4% | L 67 / C 14 / A 1 | 0 | re-probe first 82 |  | a label is wrong if the row was only transient: re-probe first |
| `error:non-chat-by-id(message-uninformative)` | 40 | 0.7% | L 40 / C 0 / A 0 | 0 | label 40 |  | a label is wrong if the row was only transient: re-probe first |
| `error:upstream-overloaded-or-transient-5xx` | 26 | 0.4% | L 22 / C 3 / A 1 | 0 | re-probe first 26 |  | a label is wrong if the row was only transient: re-probe first |
| `error:opaque-upstream-failure` | 23 | 0.4% | L 21 / C 0 / A 2 | 0 | re-probe first 23 |  | a label is wrong if the row was only transient: re-probe first |
| `error:model-rejects-request-shape` | 17 | 0.3% | L 16 / C 0 / A 1 | 0 | re-probe first 17 |  | a label is wrong if the row was only transient: re-probe first |
| `error:chat-needs-other-route` | 9 | 0.2% | L 7 / C 2 / A 0 | 0 | label 9 |  | a label is wrong if the row was only transient: re-probe first |
| `error:no-text-output(non-chat-or-budget)` | 1 | 0.0% | L 1 / C 0 / A 0 | 0 | re-probe first 1 |  | a label is wrong if the row was only transient: re-probe first |
| `error:chat-entitlement(product-not-activated)` | 1 | 0.0% | L 1 / C 0 / A 0 | 0 | label 1 |  | a label is wrong if the row was only transient: re-probe first |
| `error:chat-no-streaming` | 1 | 0.0% | L 1 / C 0 / A 0 | 0 | label 1 |  | a label is wrong if the row was only transient: re-probe first |
| `gone:model-does-not-exist` | 247 | 4.3% | L 22 / C 224 / A 1 | 0 | remove 190, fix first 27, label 24, hide 5, keep+label 1 |  | removal is not self-reversing: keep the list and a re-add path; legacy rows: re-probe first; one probe, one day |
| `gone:does-not-exist-OR-no-access(ambiguous)` | 207 | 3.6% | L 34 / C 173 / A 0 | 0 | label 185, fix first 22 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:batch-variant-not-chat` | 172 | 3.0% | L 125 / C 47 / A 0 | 0 | hide 103, label 69 |  | a hide is a filter: fully reversible |
| `gone:invalid-or-unsupported-model-name` | 171 | 3.0% | L 27 / C 143 / A 1 | 0 | remove 138, label 27, hide 5, keep+label 1 |  | removal is not self-reversing: keep the list and a re-add path; legacy rows: re-probe first; one probe, one day |
| `gone:404-opaque-upstream-message` | 96 | 1.7% | L 66 / C 29 / A 1 | 0 | label 96 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:google-models-prefix(not-found-OR-not-supported-for-generateContent)` | 95 | 1.6% | L 8 / C 87 / A 0 | 0 | label 95 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:non-chat-by-message` | 49 | 0.8% | L 49 / C 0 / A 0 | 0 | hide 49 |  | a hide is a filter: fully reversible |
| `gone:no-endpoints-or-unavailable` | 27 | 0.5% | L 12 / C 14 / A 1 | 0 | remove 13, label 12, fix first 1, keep+label 1 |  | removal is not self-reversing: keep the list and a re-add path; legacy rows: re-probe first; one probe, one day |
| `gone:decommissioned-or-deprecated` | 23 | 0.4% | L 15 / C 8 / A 0 | 0 | label 15, remove 7, fix first 1 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:model-not-found` | 18 | 0.3% | L 2 / C 15 / A 1 | 0 | remove 13, label 2, hide 2, keep+label 1 |  | removal is not self-reversing: keep the list and a re-add path; legacy rows: re-probe first; one probe, one day |
| `gone:404-provider-not-found(no-detail)` | 8 | 0.1% | L 8 / C 0 / A 0 | 0 | label 8 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:no-longer-available-to-new-users(account-state)` | 8 | 0.1% | L 0 / C 8 / A 0 | 0 | label 8 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:other` | 6 | 0.1% | L 3 / C 3 / A 0 | 0 | label 6 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:not-found(generic)` | 4 | 0.1% | L 4 / C 0 / A 0 | 0 | label 3, fix first 1 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:not-a-chat-model(may-be-Responses-API-only)` | 3 | 0.1% | L 3 / C 0 / A 0 | 0 | label 3 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:unspecific-message` | 2 | 0.0% | L 2 / C 0 / A 0 | 0 | label 2 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `gone:no-channel-for-account-group(entitlement)` | 2 | 0.0% | L 0 / C 0 / A 2 | 0 | label 2 |  | label/re-probe: a transient routing 404 or an account restriction would mislabel a live model |
| `pay:insufficient-balance` | 1,026 | 17.7% | L 923 / C 102 / A 1 | 0 | label 1,026 | `needs top-up` | label is state; clears after funding + a re-sweep, and expires after 14 d otherwise |
| `pay:model-locked-until-purchase` | 267 | 4.6% | L 267 / C 0 / A 0 | 0 | label 267 | `locked until purchase` | label is state; clears after funding + a re-sweep, and expires after 14 d otherwise |
| `pay:402-opaque-upstream-message` | 196 | 3.4% | L 195 / C 0 / A 1 | 0 | label 196 | `payment/plan? (opaque)` | label is state; clears after funding + a re-sweep, and expires after 14 d otherwise |
| `pay:gift-or-promo-balance-cannot-cover-model` | 185 | 3.2% | L 185 / C 0 / A 0 | 0 | label 185 | `needs cash balance` | label is state; clears after funding + a re-sweep, and expires after 14 d otherwise |
| `pay:model-needs-minimum-balance` | 143 | 2.5% | L 143 / C 0 / A 0 | 0 | label 143 | `needs min balance` | label is state; clears after funding + a re-sweep, and expires after 14 d otherwise |
| `pay:plan-or-premium-gated` | 137 | 2.4% | L 137 / C 0 / A 0 | 0 | label 137 | `plan-gated` | label is state; clears after funding + a re-sweep, and expires after 14 d otherwise |
| `pay:daily-check-in-required` | 17 | 0.3% | L 17 / C 0 / A 0 | 0 | label 17 | `daily check-in` | label is state; clears after funding + a re-sweep, and expires after 14 d otherwise |
| `pay:MISCLASSIFIED-realtime-model(not-a-balance-issue)` | 1 | 0.0% | L 1 / C 0 / A 0 | 0 | label 1 | `non-chat (realtime)` | label is state; clears after funding + a re-sweep, and expires after 14 d otherwise |
| `rate:rate-limited(momentary)` | 28 | 0.5% | L 18 / C 10 / A 0 | 0 | re-probe first 28 | `rate-limited` | quota labels can mislead within a day |
| `rate:quota-exhausted(free-tier-or-daily)` | 19 | 0.3% | L 10 / C 9 / A 0 | 0 | re-probe first 19 | `quota exhausted` | quota labels can mislead within a day |
| `rate:MISCLASSIFIED-really-pay(insufficient-credits)` | 18 | 0.3% | L 18 / C 0 / A 0 | 0 | re-probe first 18 | `needs top-up` | quota labels can mislead within a day |
| `rate:MISCLASSIFIED-free-access-not-enabled(account-gate)` | 5 | 0.1% | L 5 / C 0 / A 0 | 0 | re-probe first 5 | `free access not enabled` | quota labels can mislead within a day |
| `rate:provider-error(unspecific)` | 2 | 0.0% | L 2 / C 0 / A 0 | 0 | re-probe first 2 | `provider error` | quota labels can mislead within a day |
| `timeout:no-complete-answer-in-35s` | 42 | 0.7% | L 41 / C 1 / A 0 | 0 | re-probe first 42 |  | slow is not dead |

Row-level action strings for every route are in `models.csv` column `proposed_action` (51 distinct strings).

**Suggested label texts.** pay: `needs top-up`, `locked until purchase` (experientiallabs), `needs min balance` (zenmux), `plan-gated`, `needs cash balance` (gift balance cannot cover), `daily check-in` (apinex), `payment/plan? (opaque)`. auth: `bad key`, `restricted client`, `opt-in required`, `plan/consent required`, `no access/offline`, `access denied`, `auth? (opaque)`. rate/quota: `quota exhausted`, `rate-limited`, `free access not enabled`. gone and error: `not found now`, `listed but 404`, `unreachable (404)`, `not found or not for generateContent` (google `models/`), `restricted (new users)`, `no channel for account`, `batch-only`, `non-chat?`, `needs Responses API?`, `needs other route`, `no streaming`, `not activated`, `no text in budget`, `not served (upstream)`, `reasoning-heavy` (only after a confirming re-probe). Status codes `pay`, `auth`, `gone` already exist in the picker; these texts add the *cause*.

### Removal: the exact set

| Step (each applied to what the previous step left) | Routes left | Dropped |
|---|---|---|
| gone routes (of 5,794 eligible) | 1,138 |  |
|   explicit not-found / removed / invalid-model cause (incl. the ambiguous 'or you do not have access' wording) | 697 | 441 |
|   catalogue-only provenance (as stored in the snapshot) | 577 | 120 |
|   NOT named by the provider's listing after normalising `models/` and `[1m]` | 577 | 0 |
|   not the ambiguous 'does not exist or you do not have access' wording | 404 | 173 |
|   verdict visible in the stored sentence (not a 40-char snippet matched by provider style) | 400 | 4 |
|   id does not name a non-chat model | 388 | 12 |
|   no ok sibling id in the same provider (spelling / variant suffix) | 361 | 27 |
|   never ok/empty in any of the 3 bench files | 361 | 0 |
| **remove candidates** | **361** |  |
|   of which rest on a legacy record (re-probe once with the current engine before removal) | 224 |  |
|   of which confirmed by a current-engine sentence | 137 |  |
|   of which ever ok/empty in any of the 3 bench files (same day; see guardrail 1) | 0 |  |
|   of which have two independent `gone` probes | 0 |  |

Candidates by provider: alibaba 190, mistral 126, openrouter 14, ollama 12, zenmux 10, cohere 5, cerebras 2, huggingface 1, groq 1. By message class: no-endpoints-or-unavailable 13, invalid-or-unsupported-model-name 138, model-does-not-exist 190, decommissioned-or-deprecated 7, model-not-found 13. Catalogue-only `gone` routes that are NOT candidates: 390 of 751 (by cause: does-not-exist-OR-no-access(ambiguous) 173; google-models-prefix(not-found-OR-not-supported-for-generateContent) 87; batch-variant-not-chat 47; model-does-not-exist 34; 404-opaque-upstream-message 29; no-longer-available-to-new-users(account-state) 8; invalid-or-unsupported-model-name 5; other 3; model-not-found 2; no-endpoints-or-unavailable 1; decommissioned-or-deprecated 1).

**Listing normalisation: how many candidates changed.** Revision 1 compared ids to the provider listing exactly. Re-checking every one of the 57 providers with google's `models/` prefix, the `[1m]` suffix and case normalised: 40 of 986 catalogue-only eligible routes turn out to be listed, **all google** (40 of google's 138 catalogue-only rows; 0 for the other 56 providers, whose ids already matched or genuinely are not listed). Of revision 1's 467 candidates, **7 are named by the listing** (google/gemini-2.5-flash[1m], google/gemini-2.5-flash-lite[1m], google/gemini-2.5-pro[1m], google/veo-3.1-fast-generate-preview, google/veo-3.1-generate-preview, google/veo-3.1-lite-generate-preview, google/aqa); three are `[1m]` google ids, three are veo video models and one is `aqa`. 4 ok routes were also mislabelled catalogue-only (sec 2.1).

**Reconciling the counts: 467 (revision 1) -> 361 (now), and the reviewer's independent 454.**

| Set | Routes | Difference |
|---|---|---|
| Revision 1 | 467 |  |
|   - google, all 90 (demoted to re-probe-first): 7 named by the listing, 8 `no longer available to new users` (account state), 83 (of 90) with the verdict invisible in the 40-char snippet and google's full sentence "or not supported for generateContent" | -90 | google |
|   - ids that name a non-chat model (alibaba 6: omni-realtime, audio, reranker, embedding, guard; mistral 4: ocr, mamba; cohere 2) | -12 | hide, do not call 'gone' |
|   - verdict not visible in the truncated snippet (kilo 2 "requested model 'x' doe", cohere 1 "was r") | -3 | re-probe first |
|   - truncated ambiguous tail "Model does not exist or you do" (cerebras) | -3 | ambiguous wording |
|   + cerebras "is archived" (2), which rev 1's rules missed | +2 |  |
| **Now** | **361** |  |
| Reviewer's independent set (its own regexes) | 454 |  |

Versus the reviewer's 454, revision 1 had 15 rows the reviewer's regexes did not select (kilo 2, zenmux 10, cohere 3: zenmux's "Requested model is not valid" is not matched by the reviewer's `not a valid|invalid model`; kilo's "requested model 'x' doe" and cohere's "was r" are truncated snippets) and the reviewer selected 2 rows revision 1 lacked (cerebras 2: "is archived", now added). The current set differs from the reviewer's by 12 rows it has and the reviewer lacks (zenmux 10, cohere 2) and 105 rows the reviewer keeps and this build no longer does (alibaba 6, mistral 4, google 90, cohere 2, cerebras 3): 454 - 105 + 12 = 361.

**Edge cases.** (a) 49 of the 361 candidates have the same model id ok at another provider: the *model* still works and only this provider's route is dead, the strongest reason to remove the route rather than the model. (b) alibaba's 190 are legacy "Model not exist." records (one probe; "not exist" can also mean region or activation, and 12 catalogue-only alibaba ids do answer ok); alibaba's listing names 172 ids while its catalogue holds 419 eligible routes. (c) mistral's 126 come from the current engine ("Invalid model: ..."), the strongest evidence in the set, but 8 catalogue-only mistral ids also answer ok. (d) About 25 mistral/google candidates in revision 1 were duplicate spellings of a listed model (alias, do not merely remove).

### Picker impact (routes, by action class)

Whole picker (5,794 eligible routes): label 2,668 (46.0%), keep 1,787 (30.8%), re-probe-first 609 (10.5%), remove-candidate 361 (6.2%), hide-filter 313 (5.4%), fix-first 52 (0.9%), keep+label(other) 4 (0.1%). The 238 non-chat routes stay excluded from probing. Removing the 361 candidates (after their second probe) shrinks the picker from 6,032 to 5,671 routes (6.0% of 6,032); the 313 hidden rows plus 52 fix-first duplicates would leave the default view (365). Per provider:

| provider | eligible | keep (ok) | label | hide | remove | re-probe first | fix first | other keep |
|---|---|---|---|---|---|---|---|---|
| openrouter | 469 | 236 | 173 | 23 | 14 | 22 | 1 | 0 |
| aihubmix | 424 | 272 | 47 | 0 | 0 | 105 | 0 | 0 |
| alibaba | 419 | 107 | 43 | 29 | 190 | 24 | 26 | 0 |
| infron | 411 | 253 | 10 | 86 | 0 | 62 | 0 | 0 |
| kilo | 403 | 7 | 372 | 0 | 0 | 24 | 0 | 0 |
| nousresearch | 393 | 288 | 13 | 59 | 0 | 31 | 2 | 0 |
| openai | 324 | 46 | 194 | 41 | 0 | 21 | 22 | 0 |
| experientiallabs | 297 | 10 | 267 | 1 | 0 | 19 | 0 | 0 |
| zenmux | 208 | 6 | 148 | 26 | 10 | 17 | 0 | 1 |
| mistral | 200 | 20 | 22 | 4 | 126 | 28 | 0 | 0 |
| orcarouter | 180 | 2 | 161 | 0 | 0 | 17 | 0 | 0 |
| google | 161 | 9 | 112 | 14 | 0 | 26 | 0 | 0 |
| tokenrouter | 142 | 3 | 134 | 0 | 0 | 5 | 0 | 0 |
| huggingface | 134 | 123 | 8 | 0 | 1 | 2 | 0 | 0 |
| xkiro | 132 | 53 | 73 | 0 | 0 | 6 | 0 | 0 |
| pollinations | 131 | 106 | 15 | 7 | 0 | 3 | 0 | 0 |
| veniceai | 126 | 3 | 114 | 0 | 0 | 9 | 0 | 0 |
| nvidia | 111 | 9 | 92 | 1 | 0 | 9 | 0 | 0 |
| deepseek | 106 | 0 | 94 | 0 | 0 | 12 | 0 | 0 |
| opencode | 98 | 3 | 69 | 0 | 0 | 26 | 0 | 0 |
| commandcode | 84 | 2 | 70 | 0 | 0 | 12 | 0 | 0 |
| gmicloudai | 77 | 0 | 68 | 0 | 0 | 9 | 0 | 0 |
| anymodel | 75 | 68 | 4 | 0 | 0 | 2 | 0 | 1 |
| tokenharbor | 63 | 9 | 53 | 0 | 0 | 1 | 0 | 0 |
| kiraai | 60 | 2 | 45 | 0 | 0 | 13 | 0 | 0 |
| cloudflare | 59 | 17 | 19 | 0 | 0 | 23 | 0 | 0 |
| bai | 59 | 2 | 52 | 2 | 0 | 3 | 0 | 0 |
| nararouter | 54 | 10 | 15 | 0 | 0 | 28 | 0 | 1 |
| llm7 | 49 | 5 | 39 | 5 | 0 | 0 | 0 | 0 |
| teamorouter | 46 | 2 | 35 | 3 | 0 | 6 | 0 | 0 |
| cohere | 37 | 18 | 3 | 2 | 5 | 8 | 1 | 0 |
| apinex | 34 | 2 | 28 | 0 | 0 | 3 | 0 | 1 |
| ollama | 31 | 6 | 13 | 0 | 12 | 0 | 0 | 0 |
| nscale | 21 | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| hcnsec | 20 | 12 | 4 | 0 | 0 | 4 | 0 | 0 |
| bluesminds | 18 | 4 | 8 | 0 | 0 | 6 | 0 | 0 |
| chutes | 14 | 0 | 14 | 0 | 0 | 0 | 0 | 0 |
| anthropic | 13 | 13 | 0 | 0 | 0 | 0 | 0 | 0 |
| groq | 12 | 5 | 2 | 4 | 1 | 0 | 0 | 0 |
| routllm | 12 | 0 | 12 | 0 | 0 | 0 | 0 | 0 |
| agnes | 12 | 3 | 0 | 6 | 0 | 3 | 0 | 0 |
| seekai | 12 | 0 | 0 | 0 | 0 | 12 | 0 | 0 |
| fanar | 11 | 6 | 1 | 0 | 0 | 4 | 0 | 0 |
| bigmodel | 11 | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| vyceai | 7 | 6 | 1 | 0 | 0 | 0 | 0 | 0 |
| cerebras | 7 | 0 | 5 | 0 | 2 | 0 | 0 | 0 |
| sambanova | 7 | 0 | 7 | 0 | 0 | 0 | 0 | 0 |
| aionlabs | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| agentrouter | 5 | 1 | 4 | 0 | 0 | 0 | 0 | 0 |
| inceptionlabs | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| xai | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| tabiai | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| gorouter | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| indeedwebid | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| kiosapi | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| kktoken | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| justdowork | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |


## 6. Data-quality caveats and pipeline changes

| Issue (evidence) | Effect | One-line recommended change |
|---|---|---|
| Probe sends no tools, one bare message, max_tokens 96, single sample | ok means "answers a bare chat message" only; 392 of 1,787 ok routes are thinking-only within 96 tokens | Keep the probe as the liveness test; add a second, optional tool-schema probe (#118/#119) and record it in its own field. |
| max_tokens 96 is too small for reasoning models | 55 `empty` (0.9% of eligible) | Retry `empty`/`stop_reason=max_tokens` once at 1024 and store the result under the same key. |
| Streams delivered as one burst | 81.1% of ok routes have no tok/s and `t` = time to the whole answer | Record a `burst` flag when d - t <= 50 ms; label that cell 'total', and never rank speed across burst and streamed rows. |
| Classifier reads message before status (QUOTA first) | 18 rate rows are really pay; 19 quota rows are state, not momentary | Check `insufficient|credits|balance` before `QUOTA`; split `rate` into `rate` (retry) and `quota` (state). |
| No status for non-chat / batch / wrong endpoint | 198 rows say non-chat in the provider's own sentence; 177 `:batch` routes of which 4 answer ok | Add `nonchat` (or `unroutable`) to STATUSES for sentences that say so; never derive it from the id alone (4 ok `:batch` routes, 12 chat models among the old 161). |
| Gateway rewrites provider errors to 'Upstream request failed.' | 325 routes have a status without a cause | Persist the HTTP status (probeOne already returns `http`, but bench.json records only s,t,d,r,o,a,p,k,m,w) and keep the gateway's `target_providers` in `m`. |
| `fetch failed` recorded as `error` (no HTTP response) | 270 routes (7.7% of the 3,511 current-run routes) | Do not persist a result that never got an HTTP response: requeue it (a `skip:gateway` reason). The outage breaker only fires after 30 consecutive hard results with no ok anywhere, so scattered failures slip through. |
| Legacy records: old classifier, no `m`, 40-char `p` | 2,283 routes (39.4%); 879 non-ok have no sentence | Re-probe every `gone`/`pay`/`auth`/`empty` legacy record once: the 7-day ttl skips them and `--force` re-probes everything (including the 1,404 ok legacy routes), so add a status filter to `--force`. |
| Two freshness dates | default re-probe ttl 7 d (legacy from 2026-10-06); picker display 14 d (legacy from 2026-10-13); all records written on one day | Schedule a weekly re-probe of non-ok rows and a monthly ok re-probe, or accept labels expiring together. |
| No durable 'ever answered' evidence | all three bench files are from one day; compaction prunes old records; 0 of 361 candidates have two `gone` probes | Persist an ever-ok ledger (route, first/last ok time) that compaction never prunes; require two `gone` probes on different days before removal. |
| Provider verdicts (`dead` / `needsMoney`) count `fetch failed` rows | the snapshot's needsMoney has 3 providers, this report 4 (deepseek: 94 pay + 12 fetch failed) | Exclude `fetch failed` rows from providerFlags. |
| Snapshot provenance is prefix- and suffix-blind | 40 google catalogue-only routes are in fact listed (4 of them ok) | Normalise `models/` and `[1m]` in the provenance check (menu/snapshot.mjs) so 'catalogue-only' means what it says. |
| Catalogue never removes rows | 751 catalogue-only gone routes (66.0% of gone) | Feed the removal set (sec 5) into the catalogue refresh as a tombstone list, with a listing-verified re-add path. |
| Provider sentences persisted verbatim (bench.json `m`) | one sambanova sentence carries a masked key fragment; many carry URLs and request ids | Sanitise `m` before it is written (mask `xxxx***xxxx` fragments, strip URLs); this study redacts on read, see below. |


### Rules changed after the review (clusters.mjs and the action rules in build.mjs)

- **gone:** ids ending `:batch` are always `batch-variant` (was: only when the text said so); new `non-chat-by-message` ("not supported with the Responses API", "not supported by /v1/chat/completions", "is a(n) audio/video/image/realtime model"); new `not-a-chat-model(may-be-Responses-API-only)`; new `no-longer-available-to-new-users(account-state)` (google); new `no-channel-for-account-group(entitlement)`; google `models/` sentences are their own cluster (not found OR not supported for generateContent), never a removal; "archived" joins decommissioned; the ambiguous "or you do not have access" test also matches the truncated tail "or you do".
- **error:** `cannot be served|currently closed|model is unavailable|no available providers|no available channel` now runs BEFORE the overload rule (45 aihubmix rows move from overload to model-not-served); new `chat-needs-other-route` ("must be called via", Interactions API), `chat-no-streaming`, `chat-entitlement(product not activated)`; `non-chat-by-message` no longer swallows those; `does not contain text output` is its own cluster (non-chat only if the id also names a non-chat model); shape/opaque rows whose id names a non-chat model become `non-chat-by-id` (label `non-chat?`).
- **removal rule:** listing compared after normalising `models/`, `[1m]` and case; the sentence must show a verdict (a 40-character snippet matched only by provider style is not evidence); ids naming a non-chat model are excluded; siblings and never-answered checks as before.
- **redaction:** `redact()` in lib.mjs masks key-like fragments and strips URLs and bare domain/path links from every message that reaches models.csv, data.json, sweeps.json, reconcile.json and this report; verify.mjs fails if any deliverable matches a key or URL pattern.

### Numbers I could not reconcile

- **The 401 rows the gateway outages "put back unrecorded".** They are not missing (pending = 0, planned 3,510 = recorded 3,510, `requeue()` re-probes them in the same run); the exact 401 keys cannot be recovered from the files (sec 7.7 gives a 264-key floor by timestamp proximity).
- **Route vs key counts:** 5,794 eligible routes vs 5,793 keys; `error` is 619 routes / 618 keys and `fetch failed` 270 routes / 269 keys, all explained by one `[1m]` twin route (teamorouter/kimi-k3[1M]).
- **"Bare nvidia ids never match the org-prefixed listing"** is true for 36 bare ids but explains none of the losses: no org-prefixed sibling answers (sec 4b).
- **The reviewer's remove set (454) versus this build (361):** reconciled row-class by row-class in sec 5; the gap is google 90, non-chat ids 12, ambiguous-truncated 3, less 12 rows this build keeps (zenmux 10, cohere 2).
- The cause clusters for legacy records rest on a 40-character prefix; the 6 rows left in `*:other` are listed in `models.csv` (cause ends with `:other`). The reviewer's sample accuracy was measured on revision-1 rules and was not re-measured on the new ones.

## 7. Sweep comparison

Files: `bench.first-sweep.json` (generatedAt 2026-09-29T11:56:31.329Z, a copy of bench.json taken right after sweep 1), `bench.before-probe-all.json` (generatedAt 2026-09-29T12:35:25.113Z, taken before the probe-all run, i.e. after the partial second run) and `bench.json` (generatedAt 2026-09-29T14:29:03.034Z, final). Unit: bench key; 5,793 keys in every file. Percentages are of 5,793 keys unless a denominator is named.

### 7.1 Status distribution by stage

| Status | Sweep 1 | After partial run 2 | Final (probe-all merged) | Change sweep 1 -> final |
|---|---|---|---|---|
| ok | 1,396 | 1,404 | 1,787 | +391 |
| empty | 47 | 48 | 76 | +29 |
| pay | 138 | 179 | 1,972 | +1,834 |
| auth | 43 | 47 | 88 | +45 |
| gone | 602 | 605 | 1,138 | +536 |
| error | 343 | 225 | 618 | +275 |
| timeout | 58 | 43 | 42 | -16 |
| rate | 41 | 39 | 72 | +31 |
| skip | 3,125 | 3,203 | 0 | -3,125 |
| total | 5,793 | 5,793 | 5,793 |  |

Sweep 1 `skip` reasons (3,125 rows): unfunded 1,878, provider-dead 974, spend-cap 271, row-cost 2. The partial second run (225 records touched) did not improve coverage before the probe-all run started: 136 error/timeout rows became `skip` through the dead-provider breaker (skip 3,125 -> 3,203), and 58 skip rows got a real answer. The probe-all run (3,510 keys re-recorded) removed every remaining skip.

### 7.2 Transition matrix: sweep-1 status (rows) -> final status (columns), keys

| sweep 1 \ final | ok | empty | pay | auth | gone | error | timeout | rate | skip | row total |
|---|---|---|---|---|---|---|---|---|---|---|
| **ok** | 1,396 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1,396 |
| **empty** | 0 | 47 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 47 |
| **pay** | 0 | 0 | 138 | 0 | 0 | 0 | 0 | 0 | 0 | 138 |
| **auth** | 0 | 0 | 0 | 43 | 0 | 0 | 0 | 0 | 0 | 43 |
| **gone** | 0 | 0 | 0 | 0 | 602 | 0 | 0 | 0 | 0 | 602 |
| **error** | 6 | 0 | 4 | 0 | 23 | 303 | 3 | 4 | 0 | 343 |
| **timeout** | 14 | 3 | 2 | 0 | 0 | 6 | 33 | 0 | 0 | 58 |
| **rate** | 4 | 0 | 3 | 0 | 0 | 7 | 0 | 27 | 0 | 41 |
| **skip** | 367 | 26 | 1,825 | 45 | 513 | 302 | 6 | 41 | 0 | 3,125 |
| **col total** | 1,787 | 76 | 1,972 | 88 | 1,138 | 618 | 42 | 72 | 0 | 5,793 |

Reading it: the top-left five rows (ok, empty, pay, auth, gone) are pure diagonal because those 2,226 sweep-1 records were never re-probed (the 7-day ttl skipped them). The whole off-diagonal mass is in the last four rows: `skip` (3,125 rows) and the retryable statuses error (343), timeout (58), rate (41). Of those 442 retryable rows, 24 became ok, 3 empty, 9 pay, 23 gone, and 383 stayed in error/timeout/rate.

### 7.3 Sweep-1 `skip` rows: what they became

3,125 sweep-1 `skip` keys. All 3,125 now hold a real result (0 still skip). Final status of those keys: pay 1,825 (58.4%), gone 513 (16.4%), ok 367 (11.7%), error 302 (9.7%), auth 45 (1.4%), rate 41 (1.3%), empty 26 (0.8%), timeout 6 (0.2%). **367 became ok (11.7% of the skipped rows); 393 answered (ok or empty).**

| Skip reason (sweep 1) | rows | ok | empty | pay | auth | gone | error | rate | timeout |
|---|---|---|---|---|---|---|---|---|---|
| provider-dead | 974 | 90 | 17 | 299 | 28 | 408 | 91 | 38 | 3 |
| unfunded | 1,878 | 128 | 0 | 1,526 | 3 | 70 | 150 | 0 | 1 |
| row-cost | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| spend-cap | 271 | 149 | 9 | 0 | 14 | 35 | 61 | 1 | 2 |

Top 15 providers by number of skipped keys (final status of those keys):

| provider | skipped in sweep 1 | now ok | ok or empty | pay | gone | auth | error | rate | timeout | ok share of the skipped |
|---|---|---|---|---|---|---|---|---|---|---|
| kilo | 372 | 3 | 3 | 345 | 0 | 0 | 24 | 0 | 0 | 0.8% |
| openai | 322 | 46 | 62 | 0 | 255 | 0 | 5 | 0 | 0 | 14.3% |
| experientiallabs | 292 | 10 | 10 | 262 | 0 | 0 | 20 | 0 | 0 | 3.4% |
| mistral | 198 | 20 | 20 | 0 | 144 | 7 | 7 | 20 | 0 | 10.1% |
| zenmux | 194 | 4 | 4 | 136 | 37 | 0 | 17 | 0 | 0 | 2.1% |
| orcarouter | 167 | 2 | 2 | 154 | 0 | 0 | 11 | 0 | 0 | 1.2% |
| nousresearch | 163 | 114 | 118 | 0 | 25 | 0 | 18 | 0 | 2 | 69.9% |
| openrouter | 151 | 5 | 5 | 98 | 31 | 1 | 16 | 0 | 0 | 3.3% |
| tokenrouter | 141 | 3 | 3 | 132 | 1 | 0 | 5 | 0 | 0 | 2.1% |
| veniceai | 121 | 3 | 3 | 109 | 0 | 0 | 9 | 0 | 0 | 2.5% |
| aihubmix | 108 | 35 | 40 | 0 | 10 | 14 | 43 | 1 | 0 | 32.4% |
| deepseek | 101 | 0 | 0 | 89 | 0 | 0 | 12 | 0 | 0 | 0.0% |
| opencode | 97 | 3 | 3 | 57 | 0 | 11 | 26 | 0 | 0 | 3.1% |
| xkiro | 96 | 26 | 26 | 62 | 0 | 2 | 5 | 0 | 1 | 27.1% |
| commandcode | 83 | 2 | 2 | 62 | 0 | 0 | 19 | 0 | 0 | 2.4% |

Where the skip breaker was wrong: openai (322 skipped, 46 ok + 16 empty; per the engine's own comments it looked dead because its cheapest row was text-moderation-007), mistral (198 skipped, 20 ok; per the engine's comments its first row was a Labs model needing an opt-in), nousresearch (163 skipped, 114 ok), aihubmix (108 skipped, 35 ok), xkiro (96 skipped, 26 ok). Where it was right: kilo, experientiallabs, orcarouter, tokenrouter, veniceai, deepseek, opencode, commandcode, zenmux (each <= 3.4% ok; pay is 59-94% of their skipped rows).

### 7.4 Sweep-1 `error` rows under the new classifier

343 sweep-1 `error` keys (340 re-probed by the probe-all run) ended as: error 303 (88.3%), gone 23 (6.7%), ok 6 (1.7%), pay 4 (1.2%), rate 4 (1.2%), timeout 3 (0.9%). So **23 became gone (6.7%)**, 303 stayed error (88.3%), 17 became something else (ok 6, pay 4, rate 4, timeout 3).

Of the 23 error->gone rows I compared the sweep-1 text (`p`, 40 characters) with the final message: **18 already said "model not found / not supported / not valid / decommissioned" in sweep 1** but the old classifier filed them as `error` (that is the message-based gone rule at work: mostly huggingface "The requested model 'x' does not exist" 8, aihubmix 7, openrouter, groq, kiosapi); **5 changed for another reason**: 4 were an opaque "Upstream request failed." (cloudflare 3, nvidia 1) that returned 404 the second time, and 1 was `fetch failed` in sweep 1 (openai/text-moderation-latest). 21 sweep-1 errors were `fetch failed`; they ended gone 1, error 12, ok 4, pay 1, rate 2, timeout 1: sweep 1 also had gateway/network noise. Conversely 10 final `error` rows still carry wording a broad not-found pattern matches ("no available providers", "cannot be served"): they are the `error:model-unavailable-or-not-served` cluster of sec 3.4, deliberately left as error by the classifier. Only the provider-supplied sentence separates the two effects; the status codes are not persisted.

### 7.5 Non-transient result -> different non-transient result

**0 rows changed** (population: the 2,226 sweep-1 keys with status ok/empty/pay/auth/gone). 0 changed to a transient status, and 0 were re-probed with the same status. The reason is not stability: **0 of those 2,226 keys were re-probed at all** (the ttl skipped all 2,226), so this comparison cannot show whether a sweep-1 ok is still ok, or a sweep-1 pay is still pay. Evidence of flip-flopping would need a forced re-probe of a sample (recommended: 200 random sweep-1 ok and 200 gone rows).

### 7.6 Fresh result in sweep 1 only / probe-all only / both

"Real result" = a non-skip record. Sweep 1 gave 2,668 of 5,793 keys (46.1%) a real result; the probe-all run gave 3,510 (60.6%).

| Population | Keys | % of 5,793 |
|---|---|---|
| real result in sweep 1 only (never re-probed by probe-all) | 2,233 | 38.5% |
|   of which untouched since sweep 1 | 2,226 | 38.4% |
|   of which re-recorded by the partial second run only | 7 | 0.1% |
| real result in the probe-all run only (sweep 1 had `skip`) | 3,075 | 53.1% |
| real result in both (sweep-1 error/timeout/rate re-probed) | 435 | 7.5% |
| real result in neither sweep proper (sweep 1 skip, answered only by the partial second run) | 50 | 0.9% |
| **total** | 5,793 | 100% |

Both sweeps are in the final view, but they cover different populations: the 2,283 keys without a probe-all result (2,226 untouched + 7 + 50 from the partial second run) are exactly the 2,283 carried-over records of sec 1; every one of them is a non-transient status (ok/empty/pay/auth/gone).

### 7.7 The 401 rows the gateway outages "put back unrecorded"

I could not find them as a residue: after the probe-all run **2,283 keys have no probe-all result and every one of them has a real (non-skip) record** (57 from the partial second run, of which 50 were sweep-1 skips; 2,226 untouched since sweep 1; 0 `skip` records remain in the final file). The run's own tally says 3,510 recorded and 3,510 keys differ from the pre-run backup, so the requeued rows were re-probed later in the same run. The trace of the outages is in the timestamps: the probe-all run's records have 4 silent gaps of >= 45 s, all between 14:16 and 14:27 (469 s in total): 14:16:28-14:17:50Z (82s), 14:17:50-14:19:40Z (110s), 14:19:40-14:22:46Z (186s), 14:25:22-14:26:53Z (91s). The 264 keys recorded within 2 minutes after those gaps are the best available proxy for the rows that were put back (the log says 12 outages, 401 rows; shorter outages leave no visible gap, so this proxy is a floor, not a count). All 264 were `skip` in sweep 1. Their providers: kilo 83, experientiallabs 69, orcarouter 52, tokenrouter 31, veniceai 17, opencode 8, commandcode 2, zenmux 2. Their final status: pay 254, error 5, ok 4, gone 1, i.e. 96.2% `pay`, the outcome those unfunded providers gave everywhere else, which is what a correctly re-probed set should look like. Not verifiable from the files: which exact 401 keys were held. If you need certainty, the gateway request log is the only place the held keys would appear; the engine does not persist them.

### 7.8 Providers that moved

Provider verdict (same rule as `providerFlags`, applied to keys): sweep 1 -> final, over 57 providers: healthy -> healthy: 11; dead -> dead: 8; mostly-blocked -> mostly-blocked: 7; partial -> partial: 7; no-answer (mixed/skip) -> mostly-blocked: 4; needs-money -> mostly-blocked: 3; partial -> healthy: 3; dead -> partial: 3; mostly-blocked -> partial: 3; needs-money -> needs-money: 3; no-answer (mixed/skip) -> no-answer (mixed/skip): 2; needs-money -> no-answer (mixed/skip): 1; dead -> mostly-blocked: 1; no-answer (mixed/skip) -> partial: 1.

**Providers with nothing answering in sweep 1 that answer in the final view (12):**

| provider | keys | sweep-1 skipped | ok sweep 1 | ok final | verdict sweep 1 | verdict final |
|---|---|---|---|---|---|---|
| openai | 324 | 322 | 0 | 46 | dead | partial |
| mistral | 200 | 198 | 0 | 20 | no-answer (mixed/skip) | partial |
| experientiallabs | 297 | 292 | 0 | 10 | needs-money | mostly-blocked |
| nararouter | 54 | 52 | 0 | 10 | dead | partial |
| veniceai | 126 | 121 | 0 | 3 | needs-money | mostly-blocked |
| tokenrouter | 142 | 141 | 0 | 3 | no-answer (mixed/skip) | mostly-blocked |
| opencode | 98 | 97 | 0 | 3 | dead | mostly-blocked |
| orcarouter | 180 | 167 | 0 | 2 | no-answer (mixed/skip) | mostly-blocked |
| commandcode | 84 | 83 | 0 | 2 | no-answer (mixed/skip) | mostly-blocked |
| bai | 59 | 54 | 0 | 2 | needs-money | mostly-blocked |
| teamorouter | 45 | 44 | 0 | 2 | no-answer (mixed/skip) | mostly-blocked |
| agentrouter | 5 | 4 | 0 | 1 | dead | partial |

Largest ok gains (keys): nousresearch 173 -> 288; pollinations 39 -> 106; openai 0 -> 46; aihubmix 229 -> 272; xkiro 27 -> 53; mistral 0 -> 20; experientiallabs 0 -> 10; nararouter 0 -> 10; openrouter 229 -> 236; zenmux 1 -> 6; kilo 3 -> 7; anymodel 64 -> 68. Total ok 1,396 -> 1,787 (+391): 367 from sweep-1 skips and 24 from re-probed error/timeout/rate rows.

## 8. Corrections since revision 1 (old -> new)

| Item | Revision 1 | Revision 2 | Why |
|---|---|---|---|
| Remove candidates | 467 | 361 | listing check normalised (7 listed), google 90 demoted, non-chat ids and invisible verdicts out, cerebras archived in |
|   of which google | 90 | 0 | verdict invisible / listed / account state / not-for-generateContent |
|   legacy-record candidates / current-engine candidates | 326 / 141 | 224 / 137 |  |
| Remove-candidate provenance check (listed by the provider) | 0 of 467 | 7 of 467 were listed | google `models/` prefix and `[1m]` |
| Catalogue-only routes named by the provider listing | 0 | 40 of 986 | all google |
| ok routes labelled catalogue-only | 35 | 31 genuinely (4 are google ids the listing names) | normalisation |
| gone routes named by the listing | 333 | 340 | normalisation |
| Hidden / reclassified as non-chat | 175 gone + 161 error = 336 | 313 hidden (198 by sentence, 103 batch twins with an ok base, 12 non-chat-looking gone ids) | message- and ok-twin-conditional |
| Non-chat error rows | 161 | 149 by sentence + 40 by id only (label) + 11 chat models moved out (the total is larger than 161 because ids in the shape/opaque buckets are now counted) | chat models must not be hidden |
| gone rows with explicit non-chat text now counted | 0 (filed as 'listed but 404') | 49 | openai 23, zenmux 26 |
| `:batch` routes that answer ok | not counted | 4 of 177 | kept |
| Re-probe headline | 648 (primary action only) | 1,364 (609 primary + 519 label-and-re-probe + 224 remove-once + 12 hide) | the action column asks for more than the headline said |
| Label class | 2,491 | 2,668 | reclassified rows now labelled instead of hidden or removed |
| Overload cause | 74 rows (45 aihubmix are model-not-served) | 26 overload + 82 model-not-served | rule order |
| `[1m]` wording | 1,062 routes 'twins', 'double-counted' | 1,062 routes carry the suffix, 1 has a bare sibling route | only teamorouter/kimi-k3 |
| benchFlags | 'snapshot is stricter' | dead set identical (8); needsMoney 3 vs 4 (deepseek) | snapshot needs every record pay/unfunded; deepseek has 12 fetch-failed errors |
| `empty` | counted under works and under does-not-work | one group of its own (sec 2.4) | presentation |
| Top-up ranking | raw catalogue pay routes (deepseek #8 with 94) | listing-named pay routes (deepseek: 1); estimates only for n >= 30 | payment-first masks existence |
| Timing | median TTFT 8,935 ms 'use for ranking' over mixed rows | streamed TTFT median 7,575 ms (n 337), burst whole-answer median 9,187 ms (n 1,450); no ranking | burst rows are not first-token times |
| Pending | 'contradicts the brief'; legacy stale 2026-10-13 | pending 0 explained by requeue() and 3,510 = 3,510; 7-day re-probe from 2026-10-06, 14-day display from 2026-10-13 | labelled dates |
| Redaction | masked sambanova key fragment in 4 models.csv rows; URLs in messages | redacted in all deliverables | verify.mjs check |


## 9. Reproduce

`node plans/bench-study/scripts/build.mjs` (writes data.json, models.csv, providers.csv), then `sweeps.mjs` (sweeps.json, the sec 7 data), `reconcile_critic.mjs` (reconcile.json, sec 5 reconciliation), `report.mjs` (this file; uses `report_sweeps.mjs`) and finally `verify.mjs` (independent second code path for the headline numbers plus the redaction check; must print "all checks passed"). All scripts are read-only on `~/.uw/state` and `~/.uw/catalog` and need only Node. Freshness is evaluated at the snapshot's `benchAsOf` for determinism. `prev/` holds the revision-1 candidate list and summary the reconciliation compares against.

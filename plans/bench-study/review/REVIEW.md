# Independent review of plans/bench-study/REPORT.md

Reviewer method: own code only (scratch in this directory: `load.mjs`, `csvp.mjs`, `t1..t37.mjs`, `rem.json`). Inputs read read-only: `state/bench.json`, `bench.first-sweep.json`, `bench.before-probe-all.json`, `catalog/snapshot.json`, the 57 discovery caches, `state/bench-run*.log`, `refresh/bench*.mjs`, `menu/bench-data.mjs`, and the report's `models.csv`. No network, no gateway, no bench-cli, no writes outside `review/`.

Unit throughout: route (a snapshot model row), same as the report; "eligible" = outputKind not `nontext` and routable not false.

## 1. Headline numbers recomputed (own code)

| Claim | Report | Mine | Verdict |
|---|---|---|---|
| Routes / providers / non-chat / eligible | 6,032 / 57 / 238 / 5,794 | 6,032 / 57 / 238 / 5,794 | match |
| Unique bench keys (all / eligible) | 6,031 / 5,793 | 6,031 / 5,793 (the one collision is `teamorouter/kimi-k3` vs `kimi-k3[1M]`) | match |
| Every eligible route has a non-skip fresh record; pending | 0 | 0 (0 missing, 0 skip) | match |
| Status distribution | ok 1,787 pay 1,972 gone 1,138 error 619 auth 88 empty 76 rate 72 timeout 42 | identical (key-level error is 618) | match |
| ok-rate, all 57 providers | table in sec 1 | every row identical (e.g. nscale 21/21, huggingface 123/134, openrouter 236/469, alibaba 107/419, kilo 7/403, cohere 18/37) | match |
| 14 providers with ok-rate >= 50%, share of ok | 14, 1,421 = 79.5% | 14, 1,421 = 79.5% (openrouter at 50.3% is the boundary case) | match |
| 5 providers hold 1,062 of 1,972 pay | kilo 359, experientiallabs 267, orcarouter 160, zenmux 143, tokenrouter 133 | same five, sum 1,062 | match |
| `fetch failed` | 270 of 619 errors, 30 providers | 270, 30 providers, all `s=error`, none in any other status | match |
| `:batch` / non-chat | 175 gone, 161 error | `:batch` ids gone 172 (+3 aihubmix "not a chat model" = 175); the 161 is the report's regex cluster (reproduced from `models.csv`) | match on the stated definition; see defects D3/D6 on what the definition leaves out |
| Legacy records | 2,283 (39.4%); 879 non-ok without `m` | records identical to the pre-probe-all backup = 2,283 (ok 1,404 pay 179 gone 605 auth 47 empty 48); non-ok legacy 879, every one lacks `m`; non-legacy non-ok rows all have `m` | match |
| Remove candidates | 467 (alibaba 196, mistral 130, google 90, others 51) | own rule (gone + explicit not-found wording + catalogue-only + not ambiguous "or you do not have access" + not batch + no ok/empty same-provider sibling under normalised id + never ok/empty in any of the 3 files) gives 454; per-provider identical for alibaba 196, mistral 130, google 90, openrouter 14, ollama 12, huggingface 1, groq 1; differences are wording regexes only (zenmux 10, kilo 2, cohere 3 in theirs; cerebras 2 more in mine) | match within wording tolerance |
| None of them ever answered in any of the 3 files | 0 | 0 (and 0 routes anywhere went ok -> non-ok between files) | match, but see D4: the check has no discriminating power |
| 648 re-probe routes / 2,491 label routes | 648 / 2,491 | 648 / 2,491 (label 2,060 + "label + re-probe first" 431) | match; see D9 on what the headline hides |
| One-burst ok | 1,450 of 1,787 = 81.1% | 1,450 / 1,787 = 81.1% (`d - t <= 50`) | match |
| Median TTFT | 8,935 ms (p10 4,843, p90 16,077) | 8,935 (p10 4,841, p90 16,073; interpolation choice) | match |
| Other spot checks | 337 streamed; 311 with tok/s; 593 with o>=96, 177 with o>96; 392 `k=1`; 356 ok `[1m]` routes; last-run median TTFT 11,682 vs legacy 8,248 | all identical | match |

### Mismatches found

1. **`[1m]` twins (sec 1 table row 2; sec 6 row "Bench keys collapse `[1m]`").** Report: "1,062 routes carry a `[1m]` twin sharing a probe record" and "counts by route double-count some models". Actual: 1,062 routes carry a `[1m]` suffix, but only **1** of them has a bare sibling route (teamorouter/kimi-k3). The bare id is not a separate route for the other 1,061, so nothing is double-counted; the report contradicts itself in "Numbers I could not reconcile" (one duplicate only).
2. **Provider listing check (models.csv `listed_in_provider_listing`, sec 4b "gone but listing names the id: 333").** Prefix-blind: Google's listing ids are `models/<id>` and the route ids may carry `[1m]`. Normalising, 340 gone routes are named by their provider's listing (not 333), and **7 catalogue-only rows are listed** (all google, all inside the 467): `gemini-2.5-flash[1m]`, `gemini-2.5-flash-lite[1m]`, `gemini-2.5-pro[1m]`, `veo-3.1-fast-generate-preview`, `veo-3.1-generate-preview`, `veo-3.1-lite-generate-preview`, `aqa`. The CSV shows 0 of 467 listed. Across the whole snapshot 40 eligible catalogue-only routes are actually named by the listing (17 are `[1m]` routes whose bare id is listed).
3. **"35 ok routes are catalogue-only (the provider answers for an id its listing does not name)" (sec 2.1).** At least 4 of the 35 are google ids the listing does name (`gemini-3.1-flash-lite[1m]`, `gemini-3.1-flash-lite-preview[1m]`, `gemini-3.5-flash-lite[1m]`, `gemini-3.8-flash`); the `catalogue-only` provenance is partly an artefact of the `models/` prefix and the `[1m]` suffix.
4. **`benchFlags.dead` "uses the stricter rule with `fetch failed` counted" (sec 4f).** The snapshot's dead set is the same 8 providers as the report's `dead` verdict; it differs only in `needsMoney` (3 in snapshot: chutes, routllm, xai; report 4: plus deepseek).
5. **"Re-probe 648" headline (exec summary #1).** The report's own action column asks for a re-probe before acting on 648 + 431 ("label + re-probe first") + 326 ("REMOVE ... re-probe once first") = **1,405 routes**, not 648. The 648 is only the rows whose primary action is re-probe.

No other number I re-derived disagreed.

## 2. Attack on the REMOVE rule

Rule under test: `gone` + explicit not-found wording + catalogue-only + no ok sibling + never answered.

**Seeded sample of 40 (mulberry32 seed 20260929, `t12.mjs`).** 40 rows: 27 clearly gone or never-in-this-API ids (alibaba "Model not exist." on `qwen2p5-*`, `qwen.qwen3-32b-v1:0` Bedrock-style ids, mistral "Invalid model" on HF-style names, `ollama/vicuna`, `cohere/command` "was removed on Sep..."); 7 are aliases of a live model that a human would map (`mistral/ministral-3-8b-2512` vs listed+ok `ministral-8b-2512`, `mistral/codestral@latest` vs ok `codestral-latest`, `mistral/magistral-small` vs listed `magistral-small-latest`, google `gemini-3.7-flash@eu/@us`, `alibaba/qwen-3.6-max-preview` vs ok `qwen3.6-max-preview`): removing the duplicate spelling is harmless but the "no ok sibling" test did not see them; **6 are questionable as "gone"**: `google/veo-3.1-generate-preview` (listed, video model that exists), `google/veo-2.0-generate-001` (exists, not generateContent), `google/gemini-2.5-flash-lite[1m]` (listed; message begins "This model models/gemini-2.5-fla..." = a new-users restriction, not not-found), `google/gemini-2.0-flash-001[1m]` (same "This model ..." form), `google/learnlm-1.5-pro-experimental` (snippet cut before any verdict word), `google/gemini-3.1-pro[1m]`. So roughly 15% of a random sample is shaky, and all the shaky ones are google.

**Full-set checks (own code).**

| Check | Result |
|---|---|
| Candidates whose provider listing names the id | 7 (all google, see mismatch 2); report says 0 |
| Candidates with a same-provider listed or ok near-sibling (token-Jaccard >= 0.7, hand-scanned) | about 116 hits; on hand review the real alias cases are mistral ~25 (`ministral-3-{3b,8b,14b}-2512`, `ministral-3b/8b/14b`, `magistral-*`, `codestral*`, `mistral-medium-3-5@eu`, `mistral-small-2603@eu`), google ~37 (`@eu/@us/-thinking/-high/-low` of listed ids), kilo 2 (`hy3:free` vs listed `tencent/hy3`), zenmux 2. Harmless to remove as duplicate spellings, but they are "fix by aliasing" candidates for reach, and the rule as stated did not catch them |
| Candidates with the same id ok at another provider | 57 exact id/tail matches (informational) |
| Candidates whose evidence is a legacy 40-char snippet (`p` only) | 326 of 467, of which **120 are truncated at 40 characters and 90 of those show no not-found phrase at all** (google 83, zenmux 2, kilo 2, cohere 3). Google visible "not found" in only 7 of its 90; 8 google rows are "This model ..." (new-user restriction) |
| Candidates whose id looks non-chat (veo x7, gemini-embedding, aqa, live/native-audio, omni, ocr x2, mamba x2, rerank x2, qwen3-reranker, vl-embedding) | 25 (5.4%): the model may exist and simply not serve chat, so `gone` is the wrong word (hide, not remove) |
| Independent probes per candidate | **every one of the 467 rests on exactly one probe time**: the 326 "legacy" rows are the same record in three files; 0 candidates have two distinct-time `gone` records; 3 have an earlier `error` |
| Candidates in the user's picker recents or favourites | 0 |

Verdict on the rule: the mistral 130 (current-engine full sentence "Invalid model: X") and alibaba 196 ("Model not exist.", complete sentence) are reasonable removal candidates; alibaba is weakened because 12 alibaba catalogue-only ids answer ok (so catalogue-only is not a reliable signal, and "Model not exist." can also mean region/activation) and mistral because 8 catalogue-only ids answer ok (mistral-tiny, open-mistral-7b, codestral-2405). The **google 90 are not supported by the stored evidence** (see D2).

## 3. Attack on cause classification (30 random `error`, 30 `gone`, 30 `pay`; seeds 7/11/3; `t16.mjs`)

| Sample | Status right | Cause label right | Wrong or shaky |
|---|---|---|---|
| error (30) | 30 | 24 (80%) | 2 aihubmix "cannot be served at the moment. Check the model ID ..." sit in `upstream-overloaded-or-transient-5xx`; 3 non-chat ids in `model-rejects-request-shape` (voyage-4 embedding, cohere rerank, alibaba wan2.7-image); 1 alibaba TTS realtime id in `opaque-upstream-failure`. 14 of 30 are `fetch failed` (47%, population 44%) |
| gone (30) | 30 | 22 | openai "does not exist or you do not have access" x5 correctly left ambiguous, but they include `gpt-realtime` (exists, non-chat), `gpt-4o-search` (exists), `gpt-5-4-nano` (spelling dup of `gpt-5.4-nano`); google x3 shaky (listed veo/aqa/"new users"); tokenrouter "No available channel ... under group default" is group entitlement filed as gone |
| pay (30) | 30 | 30 | none. Messages (kilo/orcarouter/zenmux/tokenrouter/commandcode/xkiro/experientiallabs) are unambiguous funding or plan text; the 196 opaque 402s are honestly flagged as cause-unknown |

Quantified from the whole `models.csv`:

* **45 of the 74** `error:upstream-overloaded-or-transient-5xx` rows (aihubmix, "The model X cannot be served at the moment. Check the model ID ... try again later") are a model-not-served message, not an overload; the rule order (`try again` before `cannot be served`) put them in the wrong bucket. The genuine overload rows are seekai 11, a few alibaba/google/xkiro. Action (re-probe) stays right, the cause text and the "provider outage" reading do not.
* **Non-chat undercount.** The report's "175 gone non-chat/:batch" leaves out **49 `gone` rows with explicit non-chat text** (openai 23 "not supported with the Responses API" for transcribe/audio/realtime/search/moderation ids; zenmux 26 "not supported by /v1/chat/completions" for image/video/tts ids) which are labelled "listed but 404". On the error side, another ~55 non-chat-id rows sit in `model-rejects-request-shape` (35), `opaque-upstream-failure` (20) beyond the 161.
* `pay` is the most reliable cluster; the remaining risk is that a payment gate answers before a model-existence check (D5).

## 4. `fetch failed` and the outage window

Facts: 270 records, all `s=error, m="fetch failed"`, 30 providers, last run only (12:51-14:25Z). Earlier sweeps had 21 of 343 (first sweep, 0.4% of 5,781 probes) and 19 of 225 (pre-probe-all); the last run had 270 of 3,510 (7.7%).

Evidence for a gateway/probe artefact: (a) time clustering: 13.6% of last-run records between 13:10 and 13:50Z are `fetch failed` vs 4.3% outside that window; (b) burst structure: 23 groups of >= 4 `fetch failed` within 3 s across 3-6 different providers (largest 8 rows / 6 providers at 13:38:26Z), which is what a connection stall looks like when 8 probes are in flight; (c) 24 have `d < 100 ms` (refused immediately), the rest died at 1-15 s; (d) 30 providers including healthy ones (openrouter 17, aihubmix 18, mistral 7); (e) no route that answered ok in an earlier file is non-ok now.

What it cannot show: the run log carries no outage timestamps (only the end-of-run "stopped answering 12 time(s); 401 rows put back UNRECORDED"), so alignment of the 12 stalls with the 13:10-13:50 window is inference, not measurement. A 4.3% background rate outside the window means not every `fetch failed` is the gateway; 16.3% of them have non-chat-looking ids vs 10.6% of the run, so a few may be probe requests that crash on odd models. Conclusion: "artefact, re-probe, do not label" is the right action and is plausible; "not verified against gateway logs" (the report's own caveat) is accurate. The claim in sec 6 that the breaker "only fires after 30 consecutive hard results with no ok anywhere" is correct per `runSweep` (`outageAfter = 30`, held results flushed once a gateway check passes).

## 5. "pending = 0" versus 401 rows put back unrecorded

* `bench-run3.log`: "3510 row(s) to probe (2283 already fresh)" and "finished -- 3510 recorded" (recorded == planned), with 12 stalls / 401 requeued. `requeue()` in `refresh/bench.mjs` puts a row back in its provider's queue during a confirmed outage; the run then continued to completion, so the 401 were probed later in the same run and recorded. The CLI text "re-probed on the next run" is generic wording for the aborted case (`stop = "outage"`), which did not happen (`gaveUp` false).
* Why pending is 0: it is not because those rows carry a first-sweep legacy record. **All 2,283 legacy records are non-transient (ok 1,404, pay 179, gone 605, auth 47, empty 48); 0 are error/rate/timeout**, because the last run re-probed every skip and every transient record in the backup (3,203 skip + 307 error/rate/timeout = 3,510). A default run today would therefore re-probe **0** legacy records for being transient, and would only pick up the legacy ones after `ttlDays = 7` (2026-10-06), not at the 14-day display cutoff the report quotes (`BENCH_FRESH_MS`); the report mentions only the 14-day date for "legacy starts going stale".
* Treatment in the report: the count (0) is right; the framing is not. Sec 0/1/6 call it a contradiction with "the brief" and later say the fate of the 401 rows "could not be verified", when the recorded==planned arithmetic verifies it. It does not overstate certainty about the rows; it slightly understates it. What the outage did leave is contamination of recorded rows (the 270), which the report does handle.

## 6. Recommendations against the guardrails

Guardrails: never remove a model that ever answered; pay/auth/rate/timeout/error/empty are state; a responding provider is never pruned; reach beats tidiness.

| Recommendation | Assessment |
|---|---|
| Remove 467 | Passes "never answered" (0) but see the caveats: 7 listed, ~25 non-chat-that-exist, 90 google without visible not-found text, 1 probe each, `never answered` history is a single day (see D4) |
| Label 2,491 pay/auth/gone-listed | Safe (labels, not removal) |
| Hide 175 gone (`:batch` and not-a-chat-model) and "reclassify non-chat / batch ids out of the chat picker: 336" | **Not safe as worded.** 4 of 177 `:batch` routes answered ok (openrouter and nousresearch `anthropic/claude-opus-5:batch`, `claude-opus-5.5:batch`), so a suffix rule hides working models; the 3 aihubmix "not a chat model" ids (`gpt-5.5-pro`, `gpt-5.2-pro`, `o3-pro`) are Responses-API chat models |
| `fix first`: reclassify 161 `error` rows as non-chat (`outputKind`) | **Not safe.** `error` is state. 33 of the 161 have no non-chat token in the id and at least 12 are chat models: commandcode x7 Claude ids ("must be called via /provider/v1/messages" = reachable through the Anthropic route), `infron/openai/gpt-5.5-pro` ("does not support streaming", the probe streams), `alibaba/qwen3-32b` ("no text output" within the token budget), `alibaba/kimi/kimi-k3` ("product not activated" = entitlement), plus captioner/other alibaba rows. Hiding them removes routes that work by another protocol or entitlement |
| No provider-level hiding | Consistent: dead/needs-money providers are kept and labelled; sambanova responded (401) |
| Top-up ranking (kilo, experientiallabs, orcarouter, zenmux, tokenrouter) | Counts correct, "unlocked" is an upper bound as stated; the ranking of **deepseek (#8, 94 routes, "fully gated")** is misleading: deepseek's listing has 2 models and 93 of its 94 pay routes are catalogue-only, so a top-up unlocks about 1-2, not 94; a payment-first check (402 before existence) masks probable `gone`. The conditional recovery estimates rest on tiny denominators and survivorship (experientiallabs 243 est. from 11 non-pay rows; kilo 126 from 20; the non-pay rows are the free-tier models) |
| Sambanova "Incorrect API key for all 7" | Fact verified: 7 of 7 `auth`, "Incorrect API key provided: abc123*****wxyz", recorded at both 10-11Z (3 legacy) and 14Z (4 new), so stable, not transient. But the provider's discovery call returned 200 with 7 models, so listing works without proving the key; "replace the key" should read "verify which key the gateway sends (the masked fragment is visible) before replacing" |
| `benchFlags` / verdicts | Fine, display-only (`style.mjs`), no pruning |
| Label freshness (14 d) | Consistent with "a label that cannot be kept fresh comes down"; the report should also say that the default re-probe window is 7 d, and that `compact` drops records past `ttlMs`, which erases the only "ever answered" evidence unless a durable ever-ok set is kept |

Privacy note (low): `models.csv` column `message` contains the masked key fragment `abc123*****wxyz` (4 rows) and many provider URLs with request ids; not a full key, but do not publish the CSV as-is.

## 7. Defects ranked

| # | Severity | Defect | Fix |
|---|---|---|---|
| D1 | High | 7 remove candidates are named by the provider's own listing (google `models/` prefix + `[1m]`); report and CSV say 0. Three are "no longer available to new users" (state), three are veo video models, one `aqa`. Same artefact makes "35 ok catalogue-only" and provenance counts partly wrong | Normalise `models/` and `[1m]` in the listing check; drop the 7 from REMOVE; re-derive the catalogue-only tables |
| D2 | High | The google 90 (19% of the remove set) are inferred from provider style, not from visible evidence: 83 of 90 snippets show no not-found phrase; 8 are "This model ... " (restriction); Google's full sentence includes "or is not supported for generateContent" (exists but other method). "`models/X is not found ...`, truncated" (sec 5 exceptions (b)) overstates what is stored | Treat google as re-probe-first, not remove; one current-engine probe of the 90 gives full text |
| D3 | High | Recommendation #3 / `fix first` would hide chat models: 4 ok `:batch` routes, 3 Responses-only aihubmix chat ids, and at least 12 of the 161 `error` "non-chat" rows are chat models reachable another way (commandcode Claude x7 via Anthropic route, gpt-5.5-pro non-streaming, kimi-k3 entitlement, qwen3-32b). Conflicts with "error is state" and "reach beats tidiness" | Make any non-chat/batch rule status-conditional and message-conditional; label ("anthropic-route only", "no streaming", "responses-only") instead of hide for these |
| D4 | Medium | "Never answered in any of the 3 files" is vacuous today: the files are all from one day, 0 routes changed ok -> non-ok, every candidate has one probe time, and `compact` prunes records past the freshness window, so the evidence disappears | Say so; require a persistent ever-ok ledger (and >= 2 independent `gone` probes on different days) before any automated removal |
| D5 | Medium | Top-up "unlocked" for deepseek is 94 in the ranking, ~2 in fact (93 catalogue-only); payment-first providers hide existence; conditional estimates use n = 11 and n = 20 with free-tier survivorship | Rank by listing-verified pay routes; drop or caveat estimates below n = 30 |
| D6 | Medium | Cause mislabels: 45 aihubmix "cannot be served ... check the model ID" filed as overload/transient (61% of that bucket); 49 explicit non-chat `gone` rows and ~55 non-chat-id `error` rows outside the "non-chat" counts | Reorder rules (`cannot be served` before `try again`); add non-chat rules for "Responses API", "/v1/chat/completions", embedding/rerank/tts words |
| D7 | Low-Medium | `pending = 0` framed as contradicting the brief; the 401 requeue is verifiable (recorded == planned == 3,510); the "legacy stale 2026-10-13" date ignores the 7-day default re-probe (2026-10-06); no statement that 0 legacy rows are transient | Reword sec 0/1/6 accordingly |
| D8 | Low-Medium | Timing table mixes burst rows (time to whole answer, 81%) with streamed rows (time to first token) and calls the median "use it for ranking"; last-run median is 42% above the earlier records (load/time contamination), so provider ordering by TTFT depends on which run measured the provider | Rank speed only within streamed rows or by `d`; state run of origin per provider |
| D9 | Low | "648 re-probe" headline undercounts (1,405 rows carry a re-probe instruction); "provider-level benchFlags stricter" claim is unsupported; `[1m]` "twin" wording wrong (mismatch 1); "plus 76 empty" is listed under both works and does-not-work | Wording fixes |
| D10 | Low | `models.csv` carries a masked key fragment and provider URLs | Redact before sharing |

## 8. Solid, shaky, and what would settle the shaky ones

Solid (reproduced exactly or verified against source): population and denominators; status distribution; per-provider ok-rate for all 57; healthy-14 share; five-provider pay concentration; `fetch failed` count and provider spread; legacy counts (2,283, 879, and 0 transient); 81% one-burst and TTFT stats; pending = 0; 648 / 2,491 / 467 class sizes; the mistral 130 and alibaba 196 candidate lists; pay cause clusters (30/30 in sample); sambanova 7 of 7 `Incorrect API key`; the direction of the `fetch failed` conclusion.

Shaky:

| Conclusion | Why | What would settle it |
|---|---|---|
| Google 90 are gone | Evidence is a 40-char prefix; 7 are listed; 8 are new-user restrictions; some exist as non-chat | One current-engine probe of those 90 (full sentence stored in `m`), then compare against listing with prefix stripped |
| Alibaba 196 and mistral 130 are permanently gone | One probe each; 12 alibaba and 8 mistral catalogue-only ids do answer; "Model not exist." can be region/activation | A second probe on another day (and one alibaba call from the other region endpoint if available) |
| 161 error "non-chat" / 175 gone "non-chat/batch" | Regex clusters; at least 12 chat models inside, 4 ok `:batch` | Manual list of the 33 rows with no non-chat token in the id; status-conditional rule |
| `fetch failed` is purely a gateway artefact | Time clustering and bursts support it; 4.3% background and no stall timestamps | Re-probe the 270 (expected mostly ok or their true state); compare with CCR gateway log timestamps of the 12 stalls |
| Top-up value per provider | Upper bounds; payment-first masking; tiny n | Probe one listing-verified pay route per provider after a small top-up, or read provider pricing/limits pages |
| Sambanova needs a new key | The gateway may send a different or stale key than the one that lists models | Check the vault key against the masked fragment and make one direct call outside the sweep |
| Speed rankings | 81% burst, single sample, load-dependent | Repeat 3 samples per top route at low concurrency |

## 9. Verdict

**Needs corrections before it is shown to the user.** The measurement layer is sound and reproducible (every headline number matched). The decision layer (label vs remove) has three problems that could make the user act wrongly: D1/D2 (part of the remove set is not gone), D3 (hide/reclassify rules would hide working or reachable chat models), D5 (top-up ranking for deepseek). Required corrections: remove the 7 listed rows and demote google 90 to re-probe-first; make the non-chat/batch rule status- and message-conditional and list the chat models inside the 161 and the 4 ok `:batch` routes; fix the listing check, the `[1m]` wording, the pending framing and the 648 headline; rank top-up by listing-verified routes; add the one-probe/one-day caveat to the "never answered" guardrail. With those changes the label side (2,491) and the re-probe side can be shown as is.

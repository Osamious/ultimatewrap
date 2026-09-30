# Live model status: plan

Branch: `feat/model-benchmark-columns`. Written 2026-09-30. Status: PLAN ONLY, nothing implemented.
Scope: the picker updates a model's status from REAL usage seen in the router's own usage log, with one tiny
confirmation probe when a failing model answers again. No daemon, no timer, no gateway restart, no change to
`state/bench.json`, its lock or the sweep engine's scheduling.

REVISION 2 (2026-09-30) applied after an independent critique (verdict REVISE). The body below has been edited in place; the
section "Revision 2: changes from critique" at the end lists every change with its evidence. Where an older sentence and
Revision 2 disagree, Revision 2 wins. Read-only re-measurements for this revision are marked (re-measured).

Fixed user decisions (not reopened here):
1. Recorder runs ON PICKER OPEN: one quick read-only catch-up of new rows since a stored watermark.
2. Failing -> 200 runs ONE confirmation probe of that single model (`probeOne`, our prompt "Say hello in 5 words.").
   The user's real conversation text is never stored.
3. 429 -> rate, 402 -> pay, 401/403 -> auth, 404 model-not-found -> gone act at once. 5xx and timeouts mark `error`
   only after 2 consecutive with no 200 between. 400s are ignored unless the stored error text clearly says otherwise.

Population words used below (project rule: a count names its population). "usage rows" = rows of
`usage_events` in `usage.sqlite`, read read-only on 2026-09-30: 69,633 rows at the first read (ids 1..69,633,
2026-09-01T19:33Z .. 2026-09-29T22:24Z); the file grows while the gateway runs (max id 69,685 at a later read).

---------------------------------------------------------------------------------------------------------

## 0. What the investigation changed (read this first)

These are measured facts that change the earlier findings. Each one drives a design choice below.

| # | Finding (population in brackets) | Consequence |
|---|---|---|
| F1 | The `client` column CANNOT tell probes from real use. [69,633 usage rows] 69,557 are `Profile: Claude Code`, 76 are `Local Gateway`. On 2026-09-29, 13,298 of 13,300 rows are `Profile: Claude Code`. `path` is `/v1/messages` on all 69,634 and `method` is POST on all. `credential_id` is empty on all rows. | There is no way to exclude probe traffic from history. It has to be TAGGED going forward (F2). |
| F2 | CCR 3.0.22 fills `client` from the request header `x-ccr-client` first (bundle `dist/main/cli.js`, function `sZ`: `x-ccr-client` ?? `x-client-name` ?? `x-forwarded-client-cert`, then the key/profile name, then the User-Agent). `probeOne` sends none of these. | Add `x-ccr-client: uw-probe` to every UW probe. The recorder then excludes `client = 'uw-probe'` exactly. Needs a live check first (step 0 of C1): send one tagged probe, read back `client`. |
| F3 | Failed rows carry `input_tokens = 0` always. [all 9,937 non-200 usage rows on and before 2026-09-29 with a bucketed count: 9,934 have 0, 3 have 1..59]. And most 200 rows are small: [59,696 rows with 200] 41,117 have 1..59 input tokens. | A "small request = probe" heuristic fails for failures (the case that matters) and mislabels real short chats. Token size is NOT used as a discriminator. |
| F4 | `usage_events` has an index on every column we need and the id is the primary key. Measured on the real file, read-only: open 1.7 ms, `max(id)` 0.1 ms, a 5,000-row batch `where id > ? order by id` 21 ms. `where created_at >= ?` plans as a SCAN, so the watermark is the id, never the time. | Catch-up cost is tens of milliseconds for a normal gap. A 13,000-row sweep burst costs about 60 ms. A 400 ms budget is generous. |
| F5 | `request_logs.source_usage_id` is NULL on all 189 rows, so it is not the join key. Join by `request_id` (indexed, and unique: 0 duplicate request ids in the 69,633 usage rows). | Message join by `request_id`. |
| F6 | `request_logs` holds only a recent window: 189 rows, 2026-09-29T21:00Z .. 22:24Z (about 1.5 h). Inside that window every non-200 usage row joins: 157 of 157 usage failures in the window have a request_logs row. Its `error` / `gateway_error` columns are at most 51 characters (6 rows have one); the provider's sentence lives in `response_body_text` (max 163,885 chars on a row). `response_body_text` is NOT safe to read as a prefix: on failing rows it can embed model output (critic: 4 google rows carry `candidates[].content.parts[].text` at offsets 462-786; a 499 anthropic body is an assistant message object) and 34 of 163 2,048-char prefixes are cut mid-JSON. (re-measured) 155 of 164 non-200 bodies are valid JSON and all 155 have `$.error.message`. | Messages exist only for recent failures. Older ones classify from the status code alone and say so in `m`. The message is extracted INSIDE SQLite with `json_extract(... '$.error.message')`; the body never enters JS and no prefix text is ever stored (Revision 2, R2-1). |
| F7 | `usage_events.model` = the upstream model id, often ALREADY carrying the provider prefix (`provider` = the upstream provider name; 60 distinct, none contains `/`); `logical_model` = what the caller asked for. Our probes send `model: provider/id`. (re-measured) `model` starts with `provider/` on 46,152 of 69,971 usage rows, including all `anthropic` rows (58,380 of 69,971); non-anthropic prefixed rows: 2,383 (nvidia's real ids start with `nvidia/`). The same Claude model appears as `claude-sonnet-5` and as `anthropic/claude-sonnet-5`. | The key is derived by a two-step rule against the snapshot, not a blind concatenation (section B step 1). `logical_model` is never used for the key. |
| F13 | (critic, re-measured here, same direction) Same-key consecutive 5xx pairs with no 200 between: 840 pairs (critic) / 854 (re-measured). Critic: 31% within 10 s, 47% within 60 s, median gap 110 s. Re-measured: 20% within 10 s, 37% within 60 s, 44% within 120 s, median 156 s, 98% within 24 h. | Claude Code's own retries satisfy a naive "two consecutive" rule within seconds. The rule must require a time separation (R2-5). |
| F14 | (critic, re-measured) Real non-anthropic usage is thin: 2,402 non-anthropic usage rows across 2026-09-01..09-28 (many of them sweeps); on 09-29, 9,189 of 13,535 rows are sweep or keysync probes. Most real traffic is the `anthropic` subscription route. | The feature mostly reports the anthropic route plus occasional free-model use. Stage the build and re-evaluate value before C4/C5 (R2-9). |
| F15 | (critic) Fallback routing is currently inert: all 196 route traces say `fallback: off` and `route_attempt_count = 1`; `provider`/`model` in `usage_events` are the FINAL attempt. Structured attempt sources exist: `request_logs.route_attempt_count`, `request_route_traces.attempt_count`, and `$.error.attempts[]` in the error body. | The earlier claim "attempts live only in a per-attempt body" was wrong; the blind spot is real only if fallback is ever turned on (R2-8). |
| F8 | `duration_ms` is never null (min 25, max 1,105,186). `output_tokens` is present. There is no first-token time and no reply text. `created_at` is the request START (ISO Z). | Observation record has `d`, `o`, no `t`, no `p` (no preview). `a` = completion time = `created_at + duration_ms`. |
| F9 | Status mix. [69,633 rows] 200: 59,696; 400: 3,059; 429: 2,028; 402: 1,962; 404: 1,098; 403: 551; 502: 531; 503: 265; 500: 143; 401: 95; 422: 57; 504: 56; 499: 32; 410: 23; 529: 18; 522: 12; 413: 7. | The mapping table in section B covers exactly these. 499 is a client abort and is ignored. 410, 422, 413, 522, 529 need a stated rule. |
| F10 | `node:sqlite` on this Node (v25.0.0): `new DatabaseSync(path, { readOnly: true, timeout: 250 })` works on the WAL files while the gateway holds them open. It prints an ExperimentalWarning to stderr. `process.getBuiltinModule("node:sqlite")` loads in 0.2 ms. | Read-only open works. Warning is handled (section A). |
| F11 | The picker's first-frame budget is 300 ms (`test/bench-startup.mjs`, `BUDGET_MS`), and `uwpick.mjs` forbids `await`, `.then(` and worker threads (`test/uwpick.test.mjs`). Spawning a detached child from Node costs 11 ms on the parent side (measured). | The catch-up must NOT run before the first frame, and not in the picker process. A detached one-shot child is spawned right after the first frame. |
| F12 | The classifier (`classifyHttp`, `extractMessage`, `saysGone`) lives in `refresh/bench.mjs`, which imports fetch code. `test/bench-counts.test.mjs:253` forbids `refresh/` and `keysync/` in the picker's static import graph. | The engine cannot run in the picker. The engine lives in `refresh/` and runs in the child. The picker only reads a small JSON file, through `menu/`. This also removes any need to move or duplicate the classifier. |

---------------------------------------------------------------------------------------------------------

## Architecture in one picture

```
 picker open (menu/uwpick.mjs)
   |  BEFORE the first frame: reads ONLY state/observed.json (~1 ms), applies its precomputed `prov` block, never bench.json
   |  after the first frame: overlay merged into loadBench() when a model screen is first drawn (existing lazy site)
   |  kill switch: state/observe.off present -> no spawn AND the overlay is ignored by every reader
   |  menu/observe-launch.mjs: if last run > 30 s ago and no lock -> spawn DETACHED, then carry on
   v
 node --no-warnings refresh/observe-cli.mjs --catchup            (one-shot child, exits by itself)
   |  refresh/observe.mjs: open usage.sqlite READ-ONLY (path from menu/ccr-client.mjs CONTRACT)
   |  rows with id > watermark, client <> 'uw-probe', batch 5,000, 1.5 s budget
   |  classify with refresh/bench.mjs classifyHttp, apply the state machine (hard / 2-consecutive / ok)
   |  writeAtomic state/observed.json  (under state/observed.lock)
   |  failing -> 200 flips: spawn DETACHED `observe-cli.mjs --confirm <key>` (at most 3, capped per key)
   v
 node refresh/observe-cli.mjs --confirm provider/id              (one-shot child)
      probeOne through the gateway, tagged uw-probe, own prompt -> record with a real preview + ttft
      merged into state/observed.json under the lock. bench.json is never touched.

 picker: loadBench(): per key, the NEWER of bench.json record and observed.json record wins.
         uwpick loop: statSync(observed.json).mtime changed on a keystroke -> reload reader + recount (sync).
```

ADR (decision record).
- Decision: detached one-shot child, engine in `refresh/`, overlay file read by the picker through `menu/`.
- Drivers: 300 ms first-frame budget (F11); import-graph rule (F12); "no daemon, no timer" (decision 1); update-resilience.
- Alternatives: (a) in-process synchronous catch-up in the picker with the classifier moved to `menu/` (rejected: it
  refactors ~200 lines of tested regexes for a saving the user cannot see, and puts a sqlite open and a parse on the
  picker's path); (b) spawnSync before the first frame (rejected: node cold start blows the 300 ms budget);
  (c) a resident watcher (rejected by decision 1).
- Why chosen: the first frame is untouched (cost on the picker: 11 ms after it, one stat per keystroke), the classifier is reused
  not duplicated, a crash in the child cannot reach the picker.
- Consequences: this open's fresh events show up within about a second, on the next keystroke, not on the first frame.
  The very first frame always shows what the PREVIOUS run found. Acceptable: the user reads the list, not the first frame.
- Follow-ups: keysync dev scripts that call `/v1/messages` are untagged (they are real requests, so their outcomes are
  valid observations; only sweeps and confirmations must be tagged).

---------------------------------------------------------------------------------------------------------

## A. Data source module

### Placement
- `refresh/observe.mjs`: the engine (reader, classifier glue, state machine, overlay writer). Imports
  `menu/ccr-client.mjs`, `menu/bench-data.mjs`, `menu/atomic.mjs`, `refresh/bench.mjs`, `refresh/bench-lock.mjs`.
- `refresh/observe-cli.mjs`: entry: `--catchup` (default), `--confirm <key>`, `--status`, `--dry` (compute, write
  nothing), `--reset` (delete `state/observed.json`), `--backfill-days N` (first run only, see I2).
- `menu/observed-data.mjs`: pure overlay READER and cleaner (fs, atomic, sanitize, redact only). In the picker's graph.
- `menu/observe-launch.mjs`: the spawn helper (fs, path, child_process). In the picker's graph.
- The picker graph test stays as it is; extend it to assert `menu/observed-data.mjs` and `menu/observe-launch.mjs` are
  IN the graph and that no `refresh/` or `keysync/` file is (already asserted).

### Locating the DB without APPDATA literals
`test/contracts.test.mjs:217` forbids `claude-code-router`, `node_modules`, `.claude`, `APPDATA`, `127.0.0.1` in
`menu/` and `refresh/` except in `ccr-client.mjs` and `cc-contract.mjs`. So the path is added to the CONTRACT in
`menu/ccr-client.mjs` (an allowed file), next to `servicePath`:
```
dataDir:   process.env.UW_CCR_DATA_DIR || path.dirname(servicePath)   // same dir as service.json; getAppInfo().dataDir exists but costs ~7 s
usageDb:   path.join(dataDir, "usage.sqlite")
requestLogsDb: path.join(dataDir, "request-logs.sqlite")
probeClient: "uw-probe", clientHeader: "x-ccr-client"
```
`UW_CCR_DATA_DIR` is an env NAME, not a path literal; it is how tests and QA point the engine at a temp directory.
`observe.mjs` only reads `CONTRACT.usageDb`. The needle test must keep passing with no allowlist change. Add a test that
`observe.mjs` contains none of the five needles and that `CONTRACT.usageDb` follows `UW_CCR_DATA_DIR`.

### Open and schema check (fails soft)
- `const { DatabaseSync } = process.getBuiltinModule?.("node:sqlite") ?? {}`; missing -> feed `unavailable:node-sqlite`.
- The one ExperimentalWarning is swallowed by the child being started with `--no-warnings`, and by a scoped shim in
  `observe.mjs` (wrap `process.emitWarning` while requiring the module, then restore) so a manual run is quiet too.
  Nothing else on stderr is filtered.
- `new DatabaseSync(usageDb, { readOnly: true, timeout: 250 })`, then `PRAGMA query_only = 1`. Never `wal_checkpoint`,
  never `VACUUM`, never write. The files stay held by the gateway; a read-only WAL reader is what F10 measured.
- Required columns, checked by `pragma table_info(usage_events)`: `id, created_at, request_id, client, provider, model,
  status_code, duration_ms, output_tokens`. Any missing -> feed `unavailable:schema`, watermark and overlay untouched,
  one line in the picker: `live feed unavailable (schema changed)`.
- Optional message source, checked separately: `request_logs` with `request_id, status_code, response_body_text, error`.
  Missing or unreadable -> no messages, feed stays OK (status-only classification).
- Every failure path returns a value (`{ feed: "unavailable:<why>" }`), none throws to the CLI's top level.

### Watermark, backfill, budget
- Watermark = the last `usage_events.id` EXAMINED (not only used), so excluded rows (probe traffic, 400s) are passed over
  once. It is stored with the `created_at` of that row (`wm.at`) and the `sqlite_sequence` value (`wm.seq`) for reset
  detection (section G).
- First run (no watermark) starts at: if any tagged row exists, `max(min id where client='uw-probe', first id inside
  the backfill window)`; if none exists yet, the CURRENT `max(id)` (history is not read; the picker note says the live feed
  starts now). Default backfill window 3 days, resolved as `select id from usage_events where created_at >= ? order by id
  limit 1` (0.9 ms measured). See I2 for why untagged history is not ingested by default.
- Loop: `select id, created_at, request_id, client, provider, model, status_code, duration_ms, output_tokens from
  usage_events where id > ? order by id limit 5000`. Stop when the batch is short, or when `performance.now() - t0 > 1500`
  (the watermark is saved at the last fully processed id; the next open continues). Hard cap 100,000 rows per run.
  The client filter is applied in JS after the read so the watermark advances over probe rows.
- Time budget for the child: 1.5 s reading + classification, then the confirmation spawns. The PICKER waits for none of it.

### Picker-side launch (menu/observe-launch.mjs, called from uwpick.mjs after `recordStartup`)
- Skipped when: the persistent kill switch is set (below); `UW_OBSERVE=0` (extra, for tests and shells); `UW_PICKER_QUIT_IMMEDIATELY=1`
  (the startup benchmark and tests must never spawn); the last run finished under 30 s ago (`state/observed.run`, see C: `ranAt` is
  NOT in observed.json); `state/observed.lock` exists and is younger than 2 min.
- KILL SWITCH (R2-7). `UW_OBSERVE=0` alone is not enough: the picker is launched by a Claude Code wrapper (ctrl+g -> `uwpick.cmd`), so the
  user cannot set an env var for it. The persistent switch is the sentinel file `state/observe.off` (created and removed by
  `observe-cli --off` / `--on`; no source edit). When present: (a) `observe-launch` does not spawn, (b) `loadObserved()` returns null so
  the overlay is IGNORED by `loadBench`, `applyLive` and the reload path, (c) the confirmation entry and the catch-up entry exit at once.
  Default state on first install: overlay merge OFF until C5 lands (see H): the sentinel is written by C2 and removed by C5, so slices are independently safe.
- VISIBILITY (R2-7). `observe-cli --status` prints: enabled/disabled (and why), last run time, watermark id and its row time, models and
  pending counts in the overlay, `feed` state, skip counts of the last run, and the last error string. The picker shows an "active" stamp
  whenever overlay records are merged: `live HH:MMZ` (the newest merged live record's time) in the header/legend line (section E). `--reset`
  (deletes observed.json and observed.run) and `--off`/`--on` are documented in the runbook.
- CHILD WATCHDOG (R2-8). Both CLI modes start with `setTimeout(() => process.exit(3), 10_000).unref()` (confirm: 60 s), and on start sweep
  stale `state/observed.json.tmp-*` files older than 5 minutes (debris of a killed `writeAtomic`).
- `spawn(process.execPath, ["--no-warnings", <observe-cli.mjs>, "--catchup"], { detached: true, stdio: "ignore", windowsHide: true }).unref()`
  wrapped in try/catch. No `await`, no `.then` in `uwpick.mjs` (its guard test stays green). The helper is its own module.
- This is a one-shot process that exits by itself, not a daemon; say so in the runbook.

### Tests (section A)
`test/observe-source.test.mjs`, all on a TEMP sqlite file the test creates with the exact `usage_events` /
`request_logs` column names (from the schema dump in this plan), never the real DB:
1. missing file -> `unavailable:missing`, no throw; 2. missing `status_code` column -> `unavailable:schema`, overlay
untouched; 3. no `request_logs` table -> feed OK, messages absent; 4. watermark advances over excluded rows; 5. batch
boundary (5,001 rows -> two batches, no row read twice, none skipped); 6. budget stop mid-run resumes exactly at the
saved id; 7. first run with no tagged rows starts at `max(id)`; 8. first run with tagged rows starts at the first tagged
id inside the window; 9. the DB opened with `readOnly` cannot be written (a write attempt on the handle throws);
10. `UW_CCR_DATA_DIR` redirects `CONTRACT.usageDb`; 11. contracts needle test still passes.

---------------------------------------------------------------------------------------------------------

## B. Event -> record classification

### Reuse
Import from `refresh/bench.mjs`: `classifyHttp(status, body)`, `saysGone`, `looksLikeNotice` (the last only for confirmation probes, which
`probeOne` already applies). Import `redactClip`, `MESSAGE_CHARS`, `PREVIEW_CHARS`, `benchKey` from `menu/`. Nothing is copied. A test asserts
`observe.mjs` has no regex literal that duplicates a classifier pattern (grep for `insufficient|not found|rate.?limit` in `observe.mjs` returns nothing).
`extractMessage` is NOT used on request_logs bodies any more (R2-1): SQLite extracts the message.

### Pipeline per usage row (pure function `classifyEvent(row, msg) -> event`)
1. KEY DERIVATION (R2-3). `usage_events.model` often already carries the `provider/` prefix (F7). Rule, against the snapshot's route set
   (loaded once per run, `loadSnapshot`, ~15 ms; the keys are `benchKey(provider, id)`):
   a. `k1 = benchKey(row.provider, row.model)` (this is `provider/model`, `[1m]` stripped). If `k1` is in the snapshot, use it.
   b. Else, if `row.model.startsWith(row.provider + "/")`, try `k2 = benchKey(row.provider, row.model.slice(row.provider.length + 1))`.
      If in the snapshot, use it.
   c. Else the row is dropped, counted `unknownKey`.
   Order a-then-b is what keeps nvidia right (its real ids start with `nvidia/`, 80 rows differ from a blind strip). For anthropic the same
   model appears as `claude-sonnet-5` and as `anthropic/claude-sonnet-5`: the second resolves by step b to the same key the first resolves to by
   step a (`anthropic/claude-sonnet-5`), so both feed one record.
   DRIFT TRIPWIRE: if more than 50% of the examined NON-anthropic rows of a run are `unknownKey`, set `feed: "warn:key-mapping"`; the picker
   note reads `key mapping changed`. Unknown keys are only dropped, so nothing wrong is written.
   `credential_id` is empty on all rows and is never read; provider-level.
   ANTHROPIC SUBSCRIPTION ROUTE. Rows with `provider = 'anthropic'` are observed like any other (a 429 usage-limit is meaningful) but
   NEVER trigger a confirmation probe (it would spend subscription quota): hard-coded in the confirm gate, with a test.
2. Ignore, counted and never stored: `client === 'uw-probe'`; status 499 (client abort; 32 rows); 400, 413, 422 (invalid request,
   tool-schema, context too long) UNLESS the SQL-extracted error fields (below) make `classifyHttp` return a non-`error` class
   (e.g. "insufficient credits", "model does not exist"), in which case that class is used; rows whose completion time is more than
   5 minutes ahead of the real clock (skew).
3. `200`: proof of life. Requires `output_tokens >= 1`. A 200 with 0 output tokens is ignored (the bench engine measured provider
   notices delivered as a 200 with 0 tokens; the confirmation probe applies `looksLikeNotice`). -> class `ok`.
4. Non-200, CLASSIFICATION INPUT (R2-2). `classifyHttp`, `QUOTA`, `PLAN_STRICT` and `saysGone` run on the RAW provider text (bench.mjs:
   "classification always reads the raw body"), and a 160-character redacted clip loses decisive tokens. So the reader extracts, INSIDE
   SQLite, the full `$.error.message` plus `$.error.code`, `$.error.type` and `$.error.status` (each a short scalar), joins them with a
   space into one in-memory string `raw`, and calls `classifyHttp(status, raw)`. `raw` is never stored, logged or returned from the reader
   module; only `redactClip(<message only>, MESSAGE_CHARS)` becomes `m`. With no row in request_logs, `raw = ""`.
   - 429 -> `rate` (or `pay` if the text says the account is empty: `classifyHttp` decides). Hard.
   - 402 -> `pay`. 401 -> `auth`. 403 -> `auth`, or `pay` when the text says so. All hard.
   - 404 -> `gone`. Hard, with the provider-wide guard below. 410 -> `gone` (23 rows; answered, I3).
   - 500, 502, 503, 529 -> `error`. AMBIGUOUS. 504, 522, 524 -> `timeout`. AMBIGUOUS (`classifyHttp` says `error`; the status refines it).
     A gateway-synthesized 502 with an EMPTY body (the whole chain threw) is an ambiguous network failure like any other.
   - Any 5xx whose text `classifyHttp` reads as `gone` / `pay` / `auth` takes that hard class, exactly as a sweep would.
5. Times and fields: `d = duration_ms`, `o = output_tokens` when present, `a = floor((Date.parse(created_at) + duration_ms) / 1000)`,
   `q = request_id` (max 40 chars, sanitized), `l: 1`. Within one run the batch is SORTED by `(created_at + duration_ms, id)` before the state
   machine, because CCR's `backfillFromRequestLogs` can insert older rows with new ids (R2-5); the id watermark is still the max id examined.

### State machine per key (in `observed.json`, `pend` and `models`)
`effective(key)` = the newer of bench.json's record and the overlay record (read through `loadBench` in the CHILD; bench.json is never read
before the picker's first frame).
- `ok` event: delete `pend[key]`. If `effective` is missing or non-ok (a flip) -> write `{s:"ok", d, o, a, q, l:1}` and queue a
  confirmation (subject to the gate in D). If `effective` is already ok -> no overlay change (counted `okSeen`); ok-over-ok would only replace
  a real reply preview with an empty one.
- Hard event: delete `pend[key]`. If the class or message differs from `effective`, or `effective` is more than 6 h old -> write
  `{s: cls, d, a, q, l:1, m}`. Same class within 6 h -> no write (counted `dup`).
- Ambiguous event, TWO-CONSECUTIVE RULE (R2-5). If `effective` is already `error`/`timeout`, refresh the record. Otherwise the model is
  marked `error`/`timeout` only when there are TWO ambiguous failures for the key that are (1) at least 2 minutes apart, or in different
  5-minute buckets, AND (2) no more than 24 hours apart, with (3) no 200 for the key between them. `pend[key] = {n, s, a, q}` keeps the
  first failure; a second one under 2 minutes after it (same bucket) is a retry burst and is ignored, NOT counted (`retry`); a second one over
  24 h after replaces the first (a fresh first failure). On satisfaction write
  `{s: latest, a, q, l:1, m: "2 failures >= 2 min apart, no 200 between: HTTP <status>"}` and delete `pend[key]`.
  WHY (numbers): (critic) of 840 same-key consecutive 5xx pairs in usage_events, 31% are within 10 s and 47% within 60 s (median gap 110 s);
  (re-measured here) 854 pairs, 20% within 10 s, 37% within 60 s, 44% within 120 s, median 156 s, 98% within 24 h. Claude Code's own retries
  would satisfy the naive rule. `pend` entries older than 24 h are dropped at each run (supersedes the earlier 3-day figure).
- Order is (completion time, id) within a run; the persisted `pend` carries the rule across runs.
- Gateway-outage guard: in one run, ambiguous events inside the same 60 s bucket that hit 3 or more DIFFERENT providers with no `ok` in that
  bucket are treated as the gateway or the network failing, not the models, and are dropped (counted `outage`).
- Provider-wide 404 guard (I1, accepted with a condition). 404 on 3 or more different models of ONE provider in the same run with no 200 for
  that provider in the run and no message is downgraded to ambiguous `error` with `m: "404 across N models of <provider>: path or base URL?"`
  ONLY IF that provider had an `ok` (probe or live) within the last 14 days; otherwise the 404s stay `gone`. Evidence (critic, DB): of 954 keys
  that ever returned 404 in usage_events, 0 later returned 200, so a genuinely removed model does not recover; the guard exists only for a wrong
  base URL on a provider that recently worked.

### Joined message (failing rows only, best effort, the body never enters JS)
- Only for rows that will be classified as a hard or ambiguous failure (or a 400/413/422 candidate), and only when `request_logs` exists.
  The ONLY statement that touches a body column, in one function `readFailureText(db, ids)`, in chunks of 50 ids:
  ```
  select request_id,
         case when json_valid(response_body_text) then json_extract(response_body_text, '$.error.message') end as msg,
         case when json_valid(response_body_text) then json_extract(response_body_text, '$.error.code')    end as code,
         case when json_valid(response_body_text) then json_extract(response_body_text, '$.error.type')    end as typ,
         case when json_valid(response_body_text) then json_extract(response_body_text, '$.error.status')  end as st,
         error, gateway_error
  from request_logs where request_id in (?, ?, ...)
  ```
  The `case when json_valid(...)` guard is mandatory: `json_extract` on invalid JSON THROWS in this node:sqlite (measured just now; a plain
  `and` does not short-circuit). (re-measured) 155 of 164 non-200 bodies are valid JSON and all 155 carry `$.error.message`; JSON1 is available.
- NEVER `substr(response_body_text ...)` for anything, NEVER `request_body_text`, headers, `url`, `credential_*` or any `*_ref`. Values are
  coerced to short strings and capped in JS at 2,000 characters each before use (a message is a sentence, not a payload).
- A body that is not valid JSON, or has no `$.error.message`, gets NO raw-text handling of any kind: the stored `m` is
  `HTTP <status> (provider message not kept)` and `raw = ""`. This closes the leak where a mid-JSON prefix fell back to raw text, and
  model output embedded in a failure body (google `candidates[].content.parts[].text`; an assistant message object in a 499 anthropic body)
  can never reach a store.
- `m = redactClip(msg, MESSAGE_CHARS)` = 160 chars, the same helper the sweep stores `m` with. `p` is derived from `m` by `cleanRecord`.
- No row in request_logs (older than its ~1.5 h window, or capture off) -> `m = "HTTP <status> (provider message not kept)"`.
- Measured coverage: 157 of 157 usage failures in request_logs' window join. Outside the window: zero.

### Tests (section B) `test/observe-classify.test.mjs`
Table-driven, one case per row of F9's status list: 200/0-token, 200/normal, 429 (with and without "insufficient credits"), 402, 401, 403 (auth
and pay text), 404, 410, 400 (no message -> ignored; "model does not exist" -> gone; tool-schema text -> ignored), 499, 500/502/503/529
(ambiguous), 504/522 (timeout), empty-body 502 (ambiguous), 5xx with a "model removed" sentence (gone), 413/422 ignored.
KEY: anthropic (`claude-sonnet-5` and `anthropic/claude-sonnet-5` both -> `anthropic/claude-sonnet-5`), nvidia (`nvidia/x` against both an
`nvidia/nvidia/x` snapshot route and an `nvidia/x` route), `[1m]`, unknown -> `unknownKey`, tripwire at >50% non-anthropic unknown.
CLASSIFICATION INPUT: a 429 whose decisive phrase ("Insufficient credits") sits beyond character 160 still classifies `pay`; `raw` never appears
in a stored record or a log line.
PRIVACY: a body with google `candidates[].content.parts[].text`, and a body cut mid-JSON, produce `m = "HTTP <status> (provider message not kept)"`
or the extracted `$.error.message` only, never candidate text; the SQL text of `readFailureText` contains `json_valid`, `json_extract` and
`'$.error.message'`; NO `substr(response_body_text` appears anywhere under `refresh/` (grep test); no other body column name is selected.
TWO-CONSECUTIVE: one 502 -> none; two 502 within 10 s -> none (retry burst); two 502 3 min apart -> `error`; two 502 25 h apart -> none (the second
replaces the first); 502, 200, 502 -> none; 502 then 429 -> `rate` and `pend` cleared; a repeated `request_id` counts once; a batch delivered in id
order but created_at-reversed is sorted first; outage guard (3 providers x 502 in one minute -> nothing); provider-wide 404 guard with and without
a recent ok; ok-over-ok writes nothing; a flip failing->ok writes and queues a confirmation (never for `anthropic`); skew dropped; redaction of a
key shape and a URL; truncation to 160.

---------------------------------------------------------------------------------------------------------

## C. The overlay store

File `state/observed.json`. Single writer at a time: the catch-up child, and a confirmation child, BOTH through
`state/observed.lock` (see below). The picker only reads. `bench.json`, `bench.jsonl`, `bench.lock` are untouched.

```
{
  "schema": 1,
  "writtenAt": "2026-09-30T08:12:03.120Z",        // when THIS CONTENT was written (changes only when content changes)
  "feed": "ok",                                   // ok | warn:key-mapping | unavailable:schema | unavailable:missing | unavailable:locked | unavailable:node-sqlite
  "prov": { "openrouter.free": { "bench": {"ok": 41, "rate": 3}, "benchFlags": {"dead": false, "needsMoney": false, "alive": true, "status": "alive"},
                                  "benchAgeHist": [[490000, 40]], "live": 2, "liveOk": 1 } },   // baked fields per keyId, computed by the CHILD with bakeBench over the merged view
  "wm": { "id": 69685, "seq": 69685, "at": "2026-09-29T22:24:41.535Z" },
  "tagId": 69412,                                 // first id of a tagged row seen (null until one exists)
  "models": { "openrouter/x/y:free": { "s": "rate", "d": 412, "a": 1790000000, "q": "9f2c...", "l": 1, "m": "Rate limit exceeded..." } },
  "pend":   { "aihubmix/z": { "n": 1, "s": "error", "a": 1790000100, "q": "..." } },
  "conf":   { "openrouter/x/y:free": 1790000300 },  // last confirmation probe per key (epoch s)
  "confDay": { "d": "2026-09-30", "n": 4 },
  "stats":  { "seen": 812, "used": 6, "skip": { "probe": 799, "ignored400": 0, "abort499": 1, "unknownKey": 2, "dup": 0, "outage": 0 }, "ms": 38 }
}
```
Record shape = the bench record (`s, t, d, r, o, a, p, k, w, m, b, x`) plus `l:1` (observed live), `q` (request id), and,
after a confirmation, `v:1` (verified by our own probe; then `t, d, r, o, p` are the probe's, `a` is the probe's time) and
`cf:1` while a confirmation is in flight (with `cfa` = epoch s it was queued).
An observed record never carries `p` except a redacted provider sentence derived from `m`; an `ok` observation has no `p`.

`observed.json` is rewritten ONLY when its content changes (R2-8). The run bookkeeping that changes on every run (`ranAt`, last error, per-run
stats) lives in a second tiny file `state/observed.run` (`{ ranAt, ms, error }`), so the picker's mtime reload check (E) does not fire on every
open. The picker's 30 s launch gate reads `observed.run`'s mtime (one `statSync`, in try/catch).

`prov` (R2-4): the child, which is allowed to read bench.json, runs `bakeBench(row, mergedGet, nowMs)` for every provider row that has at least
one overlay record and stores `{ bench, benchFlags, benchAgeHist, live, liveOk }` under the row's `keyId`, stamped by the file's `writtenAt`.
`live` = how many of that provider's counted records are live-derived, `liveOk` = how many of the `ok` count are (so counts carry their
denominator: header says `ok 812 (2 live)`, never a bare total mixing populations). The merged view used for `prov` is the SAME `loadBench` merge
(newer `a` wins) the level-1 rows use, so level-0 counts and level-1 rows agree by construction.

### Merge in `loadBench` (menu/bench-data.mjs, owned by the picker agent)
- `loadBench(file = BENCH_FILE, { observed } = {})`: the overlay path DEFAULTS to `observed.json` in the SAME directory as `file`
  (so every existing test that passes a temp bench file gets a temp, absent overlay, never the real one).
- ENABLE SWITCH (R2-6, R2-7). The merge is behind `observeEnabled()` = the sentinel `state/observe.off` is ABSENT and the overlay file exists.
  C2 lands the merge code with the sentinel WRITTEN (default OFF); C5 removes the sentinel when the picker pieces exist. So every slice is
  independently safe, and a user can turn it off at any time without editing source.
- Reader: `menu/observed-data.mjs` `loadObserved(file)` returns `{ models, prov, feed, writtenAt, wm } | null` via `readJsonOr`; wrong
  `schema` -> null; `models` not an object -> null; sentinel present -> null. A torn or half-renamed file parses as null (bench.json only).
- Per key the NEWER `a` wins; a tie goes to the probe record (bench.json). An overlay entry older than the probe record is
  ignored (and pruned by the next catch-up). `get(target)` and `size` / `get.records` read the merged view, so every existing surface (rows,
  reply line, `isOk` / `isGone` filters, header ok totals, `liveAlias`) sees overlay statuses with no per-surface change.
- AGE CREDIT IS FROM PROBE RECORDS ONLY (R2-8). `get.stamp(target)` (what `oldestStampOf` and `ageHistOf` read) returns the PROBE record's `a`
  and is null for an overlay-only key: a live observation must not refresh `oldest probe` or hold back the outdated notifier, because one
  observed 200 says nothing about the other models of that provider being freshly measured. (This reverses the first draft of E's
  "a live record counts as a record for age".) The display path (`get(target).a`, `isUsable`) still uses the newer record's own time.
- `cleanRecord` keeps `l` (as `l: 1`), `q` (string, max 40, sanitized), `v: 1`, `cf: 1` only when present, so records without them keep
  today's exact shape (this is how `b`, `x`, `m` already work). `bench-store.toStored` has an explicit field list and does NOT
  list them, so a sweep or `--compact` can never copy overlay flags into bench.json.

### Lock and concurrency
- Reuse `refresh/bench-lock.mjs` `acquireLock({ file: state/observed.lock, findRunning: () => [], maxMinutes: 2, marginMs: 60000 })`.
  It is a `wx` create with stale-pid takeover. A second catch-up or a picker launch that finds it held just skips.
- The confirmation child holds NO lock while probing (up to 45 s); it takes the lock only for its read-modify-write of
  `observed.json`, retrying the lock for at least 3 s (poll every 100 ms; the catch-up holds it for tens of milliseconds, not seconds,
  so 3 s is generous). If it still cannot get it, the result is dropped and the `cf:1` record simply ages out to plain "live" (R2-8).
- A running sweep: the sweep lock is untouched and never taken. The overlay reader and the sweep never touch the same file.
  A sweep writing bench.json while the overlay is read is safe because both readers tolerate torn files and take the newer record.
- Windows: `writeAtomic` (menu/atomic.mjs) is tmp + rename and has NO retry (it rethrows after removing its tmp file). The retry lives in a
  new wrapper `writeAtomicRetry(file, text, { tries: 5, waitMs: 40 })` in `refresh/observe.mjs` that retries ONLY on `EPERM`/`EBUSY`/`EACCES`
  from the rename, then gives up quietly (next open retries). `menu/atomic.mjs` is not edited (it is in the picker's graph and used by
  every state file). Stale `observed.json.tmp-*` older than 5 minutes are removed at the start of each child run.

### Size cap and pruning (done by the catch-up writer)
- Drop entries whose key is no longer in the snapshot; entries older than the bench record; entries older than 14 days
  (`BENCH_FRESH_MS`); then, above 800 entries, drop the oldest by `a`. `pend` entries older than 24 h; `conf` entries older than 7 days.
  800 entries at ~250 bytes = about 200 KB, read on every open in about a millisecond.

### Sweeps and maintenance commands
- A sweep writes newer bench records, so overlay entries for those keys become older and are ignored, then pruned. Nothing to do in
  the sweep. The sweep's `--only ... --force` is NOT used for confirmations (section D says why).
- `--redact`: extend `redactBench` so it also redacts `m` and a non-ok `p` of `observed.json`, under `observed.lock`, atomically.
  The overlay is already redacted on write and on load (`cleanRecord`), so this is belt and braces and a test asserts it.
- History backups (`archiveBench`): bench.json only. The overlay is derived (it can be rebuilt from `usage.sqlite`) and small; it gets
  no history copies. A test asserts `bench-history/` never contains an `observed` file.
- `--reclassify-notices`: bench.json and the log only. Overlay `ok` records carry no reply text, so there is nothing to reclassify; a
  confirmation record already went through `looksLikeNotice` in `probeOne`.
- `observe-cli --reset` removes only `observed.json` and `observed.run` (a new first run then starts at `max(id)`); `--off` / `--on` create and
  remove `state/observe.off`. All three are documented in the runbook with the exact commands (R2-7).

### Tests (section C) `test/observed-overlay.test.mjs`
newer wins; tie -> probe; older overlay ignored; overlay-only key visible; torn JSON -> bench only; wrong schema -> bench only;
future `a` (> now + 5 min) refused by `isUsable`; `cleanRecord` round-trips `l/q/v/cf` and adds nothing when absent (existing
deepEqual tests unchanged); `toStored` never emits `l/q/v/cf`; sibling-directory default (temp bench file -> no real overlay read);
`get.records` counts the union; `get.stamp` returns the PROBE record's `a` and null for an overlay-only key (age credit from probes only: a live
flip leaves `oldestStampOf`, `ageHistOf` and the outdated notice unchanged); pruning rules; `--redact` on overlay; lock contention (second
writer skips; confirmation retries >= 3 s); atomic write leaves no `.tmp-` debris; `writeAtomicRetry` retries on EPERM then succeeds, gives up
quietly after 5; `observed.json` is not rewritten when content is unchanged (mtime stable across two no-op runs; `observed.run` updates);
KILL SWITCH: with `state/observe.off` present `loadBench` returns bench.json only, `applyLive` is a no-op, `observe-launch` does not spawn, the
CLI entries exit at once; removing the sentinel restores the merge; the default install state is OFF until C5.

---------------------------------------------------------------------------------------------------------

## D. The confirmation probe on a failing -> ok flip

### Why not `bench-cli.mjs --live --only key --force`
It works, but every run does the heavy things a one-model check must not: it saves a dated `bench.json` copy (30-copy history, so
flapping models would push real history out), compacts the log, and rebuilds the picker snapshot (a gateway-dependent build).
So a dedicated small entry: `refresh/observe-cli.mjs --confirm provider/id`.

### Trigger and flow
1. The catch-up writes the flip record `{s:"ok", d, o, a, q, l:1, cf:1, cfa:now}` first, so the picker can show it at once.
2. It then decides whether to confirm: not if (0) the key's provider is `anthropic` (the subscription route: a confirmation would spend subscription
   quota; hard-coded and tested; its 429 usage limits are still OBSERVED and shown), (a) a sweep is running (`sweepStatus({ findRunning: () => [] }).running`, lock file only:
   a sweep re-probes the row anyway; the note stays "live"), (b) `conf[key]` is within 6 h, (c) `confDay.n >= 10` today, (d) the
   gateway or `gatewayConnection()` is unavailable, (e) the target's worst-case row cost exceeds `ECONOMY_DEFAULTS.maxRowCost` ($0.01, the
   economy ceiling, not the sweep's $0.10: a confirmation is a courtesy, so it is held to the cheapest bar; from `buildTargets(snapshot, { only: [key] })`,
   which also skips non-text and unroutable rows), (f) the key was never
   benched AND has no prior record (a never-benched model is shown `ok`, unconfirmed: no spend for an unknown).
   At most 3 confirmations spawn per catch-up. `conf[key]` and `confDay` are set at SPAWN time, by the catch-up under its lock (not by the child
   after the probe), so a crashed or slow child, or a second picker opened meanwhile, cannot cause a second probe of the same key inside the 6 h window (R2-8).
3. Each spawns `node --no-warnings observe-cli.mjs --confirm <key>` detached (`stdio: "ignore"`, `windowsHide`).
4. `--confirm`: `gatewayConnection()`, `probeOne({ url: base/v1/messages, key, model: key, maxTokens: 96, timeoutMs: 45000 })`
   (the default prompt is `BENCH_PROMPT` = "Say hello in 5 words."; `probeOne` sends `x-ccr-client: uw-probe`), then under the lock
   writes `{ ...res, a: now, l: 1, v: 1, q: <flip request id> }` (cf cleared) and sets `conf[key]`, `confDay`. If the probe says
   `rate` / `pay` / `auth` / `error` / `timeout` / `empty` / a notice, THAT is the record: the confirmation can overrule the flip
   (that is its purpose: a 200 that was really a notice). A probe that aborts or a gateway that is down leaves the `cf:1` record,
   which the picker shows as plain live after 2 minutes. The child runs a 60 s watchdog (`setTimeout(process.exit, 60_000).unref()`).
5. `bench-lock` is not taken for one probe; it only protects `bench.json` writes, which this never does.

### Loop safety
- Confirmation probes are tagged `uw-probe`, so the recorder excludes them (rule in B). The catch-up also drops any row whose
  `request_id` equals a confirmation it is waiting on. A confirmation never triggers a confirmation.
- The 6 h per-key cap and the 10 per day cap bound spend even if tagging were to fail (a test simulates a missing tag: the caps stop it).
- The interim display: `stat` `OK`, `reply:` `[live 14:32Z] worked live; confirming...` while `cf:1` and under 2 minutes old.

### Tests (section D) `test/observe-confirm.test.mjs`
fake `fetchImpl` and injected clock: flip -> exactly one probe with the `x-ccr-client` header and `BENCH_PROMPT`; probe result written with
`v:1`, preview and ttft; notice reply overrules the flip; an `anthropic/...` flip never spawns a probe; a $0.02 row -> no probe; `conf[key]` is set at spawn (a
second catch-up right after, with the child not yet finished, spawns nothing); second flip within 6 h -> no probe; 11th of the day -> no probe; sweep lock
held -> no probe, no error; gateway connection null -> no probe; over-cost row -> no probe; never-benched key -> no probe; confirmation
row (tagged) excluded on the next catch-up; two confirms racing on the lock both land (retry) or one drops cleanly, file never torn.

---------------------------------------------------------------------------------------------------------

## E. Picker changes (owned by the picker agent P)

| File | Change |
|---|---|
| `menu/bench-data.mjs` | overlay merge in `loadBench` (section C); `cleanRecord` keeps `l/q/v/cf`; new export `isLive(rec)`; new export `bakeBench(row, get, nowMs)` = the three baked fields (`bench`, `benchFlags` with `alive`/`status`, `benchAgeHist`) factored OUT of `buildSnapshot`, so build and the at-open recount are one code path. |
| `menu/observed-data.mjs` (new) | `loadObserved`, `OBSERVED_FILE`, `feedNote(observed)`; no imports outside `menu/` leaves. |
| `menu/observe-launch.mjs` (new) | the spawn gate and detached spawn (section A). |
| `menu/snapshot.mjs` | `buildSnapshot` calls `bakeBench` (pure refactor, same output; no schema bump). `builtAt` is what the picker compares live entries to. |
| `menu/uwpick.mjs` | after the snapshot loads and BEFORE `firstFrame`: `applyLive(snap)` (reads ONLY observed.json, never bench.json); after `recordStartup`: `launchObserver()`; in the key loop: one `statSync` of `observed.json` inside try/catch (an error means "unchanged"), reload on a changed mtime. No `await`, no `.then`. The reload keeps the SINGLE `loadBench` call site (bench-view.test.mjs asserts one). |
| `menu/style.mjs` | stat cell and reply line (below); frame-height accounting for the one optional note line. |
| `menu/pick-state.mjs` | reducer accepts `{ benchOf, benchHist, benchOldestAt }` again on reload (already supported by the `benchOf` event); `extraLines` counts the live note line the same way it counts `v.notice`. |
| `menu/legend.mjs` | three new `?` entries (marker, reply prefix, `live HH:MMZ` header stamp). |

### The marker
The `stat` cell is 4 columns (`ok`, `empt`, `auth`, `pay`, `rate`, `gone`, `t/o`, `err`). No room for a glyph, and colour alone fails with colour
off, so a live record draws its code in UPPERCASE: `OK`, `RATE`, `PAY`, `AUTH`, `GONE`, `ERR`, `T/O` (and `EMPT` for completeness: the recorder never produces `empty`, but the renderer handles all 8 codes). Lowercase = a sweep or confirmation
probe wrote it; uppercase = seen in real use since. Same width, same tone colour, works with `NO_COLOR`. A confirmed record (`v:1`) is
drawn lowercase again (it is a probe measurement now) and `reply:` says `[live+probe HH:MMZ]`. Legend entry:
`stat: UPPERCASE = observed in real use after the last probe of this row; lowercase = measured by a probe`.

ACTIVE MARKER (R2-7). Whenever at least one overlay record is merged into what is drawn, the header or legend line carries a stamp
`live HH:MMZ` (the newest merged live record's time), so the user can always tell the live feed is affecting the screen; with the kill switch
on, or no overlay records, the stamp is absent. The header ok total says both populations: `ok 812 (2 live)` where `(n live)` is `prov.liveOk` summed;
it is never a bare figure mixing probed and live records.

### The `reply:` line
Prefix before the existing body, all within the existing one-line clip:
- unconfirmed live ok: `[live 14:32Z] answered HTTP 200 in 1.2 s; no reply text is kept for real requests`
- `cf:1` under 2 min: `[live 14:32Z] worked live; confirming...`
- live failure: `[live 14:32Z] HTTP 429: <redacted provider sentence>` (or `HTTP 502 x2, no 200 between`)
- confirmed: `[live+probe 14:33Z] <the reply of OUR prompt>` (previous `[cut]` / `[stream error]` rules unchanged)
Time is UTC `HH:MM` + `Z` (the picker's existing stamps are UTC).

### Provider-level counts (baked into the snapshot) and the overlay (R2-4)
Baked fields `bench`, `benchFlags`, `benchAgeHist` are computed at snapshot build. `test/bench-view.test.mjs` (around lines 410 and 421) asserts that
bench.json is NOT read at startup and that `loadBench` has one call site, so `applyLive` must not call `loadBench` before the first frame. Instead the
CHILD (which may read bench.json) precomputes the recount and stores it in observed.json as `prov` (section C). At open, `applyLive(snap)`:
1. `loadObserved()` (one small file, about 1 ms; null when the kill switch is on); no `prov`, or `observed.writtenAt <= snap.builtAt` -> return `snap` untouched.
   The comparison is `writtenAt` against `builtAt` (NOT an event's time against `builtAt`): a snapshot built after the overlay was written already baked it in
   (the build merges the overlay), and a snapshot older than the overlay does not have it.
2. Otherwise replace `row.bench`, `row.benchFlags`, `row.benchAgeHist` for each `keyId` present in `prov` with the stored values, and record
   `row.benchLive = prov.live`, `row.benchLiveOk = prov.liveOk` for the header's `(n live)`. `prov` was computed by `bakeBench` (the function `buildSnapshot`
   uses) over the SAME merged view level 1 uses, so level-0 counts and level-1 rows agree; a test builds both from one fixture and compares.
3. `snap.benchOldestAt` is NOT recomputed: age credit comes from probe records only (section C), and probe records did not change.
4. The header ok total and `gone` total are computed from `rows[].bench` in `firstFrame`, so they pick this up with no change.
Staleness: `prov` can lag a sweep that finished after the last catch-up. A sweep ends by rebuilding the snapshot (bench-cli), which makes `builtAt` newer
than `writtenAt`, and step 1 then ignores `prov`. The reload path (uwpick loop, mtime change) re-applies with the same rule.
`buildSnapshot` itself merges the overlay (it calls `loadBench()` in the build, which is not the picker's startup), so the next `--build` bakes live data
in and `applyLive` becomes a no-op again. No snapshot schema bump.
Not refreshed at open (baked, and documented as such): model `outModality` `chat?` from a bench ok, the `FREE?` badge blanking, the
`aliasOf` hint. `liveAlias` reads `benchOf` live, so a live `gone`/`ok` pair does update its alias text.

### Interplay with the outdated notifier and `oldest probe`
- A live record does NOT count as a record for age (R2-8): `get.stamp` returns the probe record's `a` only, so `oldestStampOf`, `ageHistOf`, the level-0
  `oldest probe` column and the outdated notice are unchanged by live flips. One observed 200 is not a fresh measurement of the provider's other models.
- Filters `[ok]`, `[no gone]` and the header figures use `isOk` / `isGone` over `benchOf`; the reloaded `benchOf` is a new function,
  which invalidates the memo caches (they are keyed by the function). `[free]` is a badge filter and is unchanged.
- The one optional note line (`live feed unavailable (schema changed)` or `live feed: locked, showing the last update HH:MMZ`) reuses the
  outdated notice's line slot when that is empty, and is counted in `extraLines`; if both apply the outdated notice wins. The R18 frame-height
  invariant tests are the gate.

### Tests (section E) `test/live-picker.test.mjs` plus edits to existing suites
uppercase stat for `l:1` and lowercase after `v:1`, width unchanged at 4; colour-off shows the same; reply prefixes for the four cases; clip at
the 78-column floor; `prov` applied only when `writtenAt > builtAt` and only for the keyIds it names, with NO bench.json read at open; header totals; `[ok]`
and `[no gone]` see an overlay flip; note line appears once, is counted in `extraLines`, frame never exceeds `termRows` (existing invariant
suite); the reload-on-mtime path with a fake `statSync`; `uwpick.mjs` guard test (no `await`, no `.then`) still green; import-graph test still
green with the two new `menu/` modules present; `bench-startup` first-frame gate: the added open-path cost (one small read, no bench.json read when
nothing is newer) must stay inside the existing 300 ms budget, and is asserted as under +15 ms on the 5-sample run. Additional (R2-10): `applyLive`
never calls `loadBench` and never reads bench.json (spy on `fs.readFileSync` for the bench path during `firstFrame`); the single-`loadBench`-call-site test
still passes; all 8 status codes render at width 4 in upper and lower case; header shows `ok N (n live)`; the `live HH:MMZ` stamp is present iff overlay records are merged;
kill switch removes marker, stamp and merged statuses; `statSync` throwing (ENOENT, EPERM) leaves the picker running unchanged; level-0 counts equal level-1 counts on one fixture.

---------------------------------------------------------------------------------------------------------

## F. Privacy

| Stored in `observed.json` | Source | Never stored |
|---|---|---|
| status class, `d` (duration), `o` (output token count), `a` (time), `q` (request id), `l/v/cf` flags | `usage_events`: `created_at, request_id, client, provider, model, status_code, duration_ms, output_tokens` | prompts, replies, request or response bodies, headers, URLs |
| `m` (<= 160 chars) and derived `p`: the PROVIDER's error sentence, redacted with `redactClip`; or the fixed text `HTTP <status> (provider message not kept)` | `request_logs`, NON-200 rows only, ONLY through `json_extract(response_body_text, '$.error.message')` (plus `$.error.code/type/status` for in-memory classification, never stored), guarded by `json_valid`; the body itself never enters JS and there is no prefix or raw-text fallback | `request_body_text`, `*_headers`, `*_ref`, `credential_*`, the web RPC token, API keys |
| confirmation probe: `p`, `t`, `d`, `r`, `o` | `probeOne` reply to OUR prompt "Say hello in 5 words." | anything from the user's conversation |
Redaction: written through the sweep's own helper (`redactClip`, masks keys and key shapes, URLs, e-mail, opaque ids), and cleaned again on load.
Files: `observed.json` is under `state/` beside `bench.json` (same ignore rules; local only). No copy goes to `bench-history/`, logs or the snapshot.
The reader opens the DBs `readOnly`, selects named columns only, and the code path that reads `response_body_text` is a single function (`readFailureText`) with a test that
asserts the SQL text contains `json_valid`, `json_extract` and `'$.error.message'`, that NO `substr(response_body_text` appears anywhere under `refresh/`, and that no other
body column name is selected. Why (critic, measured): the earlier 2,048-character prefix could carry MODEL OUTPUT (4 google failure rows embed `candidates[].content.parts[].text`
at offsets 462-786; a 499 anthropic body is an assistant message object) and 34 of 163 prefixes were cut mid-JSON, so `extractMessage` fell back to raw text. The revised
rule keeps every model-output-bearing field out of the process. Document the same in the runbook.

---------------------------------------------------------------------------------------------------------

## G. Failure modes and edge cases (user-visible behaviour)

| Case | Detection | What the user sees |
|---|---|---|
| Gateway DB locked or busy (WAL checkpoint, `SQLITE_BUSY`) | `timeout: 250` then throw caught | Nothing on this open. Watermark unchanged, next open retries. After 3 consecutive locked runs the note line says `live feed: locked, last update HH:MMZ`. |
| WAL / SHM files missing or unreadable | open throws | same as locked; `feed: unavailable:locked` |
| DB file missing (CCR not installed or moved) | `ENOENT` | one note `live feed unavailable (no router data)` only if it worked before; otherwise silent. Statuses are bench.json only. |
| Schema drift (renamed/dropped column, table) | `pragma table_info` | `live feed unavailable (schema changed)`. Overlay kept but stops growing; `--status` names the missing column; doctor line. |
| DB rotated, pruned or reset (ids restart) | `wm.id > max(id)`, or the row at `wm.id` has a different `created_at` than `wm.at`, or `sqlite_sequence.seq < wm.seq` | Watermark re-initialised as a first run with the backfill rule (tagged rows only). Overlay entries are kept (their `a` keeps them correctly ordered). One line in `--status`. Silent in the picker. |
| Clock skew | event `a` more than 5 min ahead of the real clock | event dropped (`stats.skip`), `isUsable` also refuses future records on read. |
| Duplicate events | same `request_id`; id watermark | idempotent: a re-run of the same rows writes the same overlay. Duplicate `q` counts once toward the 2-consecutive rule. |
| A model flapping (ok/429/ok/429) | per-event | each flip writes; the `dup` rule (same class within 6 h) and the 6 h confirm cap bound writes and spend. The record always shows the newest event. |
| Provider renamed or model removed from the snapshot | key not in snapshot | event dropped (`unknownKey`); existing overlay entry pruned. |
| A burst of ~13,000 rows from a sweep | client filter + budget | tagged rows skipped by client (watermark passes over them); untagged burst (old code) is read at 5,000/batch, about 60 ms total, and could mark models from sweep failures: the tag epoch (first run at the first tagged id) is what prevents ingesting history. |
| Two pickers open at once | `observed.lock` | the second skips its catch-up. A picker never writes. |
| Catch-up child dies mid-run | atomic write happens once at the end | overlay and watermark are the previous consistent pair; nothing partial. Stale lock taken over after its pid is gone. |
| Windows path or permission error on `state/` | `writeAtomicRetry` (EPERM/EBUSY/EACCES, 5 tries) then gives up, caught | silent; next open retries; `--status` shows the error (from `observed.run`). No debris (`writeAtomic` removes its tmp; stale `.tmp-*` swept at child start). |
| Child hangs | watchdog `setTimeout(process.exit, 10_000).unref()` (confirm: 60 s) | the child exits; the lock goes stale by pid and is taken over. |
| `statSync` of observed.json throws in the picker | try/catch | treated as unchanged; picker keeps running. |
| Node without `node:sqlite` | feature check | `feed: unavailable:node-sqlite`, note once. |
| Gateway down during a confirmation | `gatewayConnection()`/`probeOne` result | flip stays `ok` "worked live" without `v`; shown plain after 2 min. |
| Wrong-path 404 across a provider | 3+ models of one provider in a run, no message, AND that provider had an ok in the last 14 days | downgraded to `error` "404 across N models: path or base URL?" instead of N `gone`. Otherwise the 404s stay `gone` (0 of 954 keys that ever returned 404 later returned 200). |
| Claude Code's own retries (a 502 burst) | two ambiguous failures under 2 minutes apart | counted once; no `error` mark (see the two-consecutive rule; 31-47% of same-key 5xx pairs are within 10-60 s). |
| `applyLive` prov stale after a sweep | `writtenAt <= builtAt` | `prov` ignored; the rebuilt snapshot already has the data. |
| User wants it off | sentinel `state/observe.off` | no spawn, overlay ignored everywhere, no `live` stamp. `observe-cli --off` / `--on`. |
| Model answers 200 with a notice as content | `output_tokens = 0` ignored; confirmation `looksLikeNotice` | not shown `ok`; or shown the notice's class after the probe. |

---------------------------------------------------------------------------------------------------------

## H. Work breakdown, ownership, review

Agents: R = refresh agent (owns `refresh/*` and new `test/observe-*.test.mjs`); P = picker agent (owns `menu/*` and the existing picker
tests: `test/uwpick`, `style`, `legend`, `pick-state`, `level0`, `snapshot`, `bench-counts`, `bench-view`); D = docs agent (owns `docs/*`);
V = verifier and reviewers (read-only, separate lanes: authoring never approves itself). Rule: no two agents write the same file in the same
commit round; `menu/ccr-client.mjs` is touched only in C1; `refresh/bench.mjs` only in C1 (one line).

PRECONDITION (R2-6). The working tree has 31 uncommitted changes to the in-flight level-0 / model-level picker work under `menu/` and `test/` (owned by that work's
agents). NOTHING in this plan starts writing to those files until that work is COMMITTED. C1 waits for that commit; C2 and C5 are written on top of it (rebased, never
edited in parallel with it). C2's overlay merge lands behind the enable switch with `state/observe.off` written (default OFF); C5 removes the sentinel. If the in-flight
work is not yet committed, only C0 (read-only spike) may run.

STAGING AND VALUE GATE (R2-9). Expected signal is small (F14: 2,402 non-anthropic usage rows in the 28 days before 09-29, many of them sweeps; on 09-29, 9,189 of 13,535
rows were sweep or keysync probes). Real signal is mostly the anthropic subscription route (429 usage limits, which are meaningful) plus occasional free-model use.
Recommendation: ship C0 to C3 first (tag, overlay reader behind the switch, read-only feed, classifier), run `--catchup --dry` and then the live feed for about two weeks with
the overlay merge OFF or shadow-only, count how many overlay records per week it would have written and how many differ from bench.json, and only then decide C4
(confirmation probe) and C5 (picker pieces). C4/C5 are built only if that count justifies the picker complexity.

| # | Commit | Owner | Files | Depends on |
|---|---|---|---|---|
| C0 | Spike, no commit: one tagged probe, read back `client` read-only; measure `applyLive` and spawn cost | R + V | none | none |
| C1 | `feat(bench): tag every UW probe with x-ccr-client: uw-probe` (starts only after the in-flight picker work is committed) | R (touches one menu file) | `menu/ccr-client.mjs` (CONTRACT: `dataDir`, `usageDb`, `requestLogsDb`, `probeClient`, `clientHeader`), `refresh/bench.mjs` (`probeOne` header), `test/bench-engine.test.mjs` (header assertion), `test/contracts.test.mjs` (env override, needles) | C0 |
| C2 | `feat(bench): observed.json overlay reader merged into loadBench, behind the enable switch (default OFF)` | P | `menu/observed-data.mjs`, `menu/bench-data.mjs`, `test/observed-overlay.test.mjs`, `test/bench-view.test.mjs` if a shape test needs the new optional fields | C1 |
| C3 | `feat(observe): read-only usage feed, classifier glue, 2-consecutive rule` | R | `refresh/observe.mjs`, `refresh/observe-cli.mjs` (--catchup/--status/--dry/--reset/--off/--on), `refresh/bench-store.mjs` (`--redact` covers the overlay), `test/observe-source.test.mjs`, `test/observe-classify.test.mjs` | C2 (shapes) |
| C4 (gated by the value review) | `feat(observe): one confirmation probe when a failing model answers` | R | `refresh/observe.mjs`, `refresh/observe-cli.mjs` (--confirm), `test/observe-confirm.test.mjs` | C3 |
| C5 (gated by the value review) | `feat(picker): live marker, reply prefix, open-time recount, live note; removes the observe.off default` | P | `menu/uwpick.mjs`, `menu/observe-launch.mjs`, `menu/style.mjs`, `menu/pick-state.mjs`, `menu/snapshot.mjs` (`bakeBench` refactor), `menu/legend.mjs`, `menu/bench-data.mjs` (`isLive`, `bakeBench`), `test/live-picker.test.mjs`, edits to `test/legend.test.mjs`, `test/level0.test.mjs`, `test/snapshot.test.mjs`, `test/bench-counts.test.mjs` | C2 (parallel with C3/C4: disjoint files) |
| C6 | `docs: live model status` | D | `docs/runbook.md` (new 6f-style section, note 6d cross-reference), `docs/qa-interactive-protocol.md` (new steps), `docs/visual-design.md` (regenerate blocks with `menu/render-legend.mjs`, the marker), `docs/C-provider-actions.md` (one paragraph: an account fix now shows live on the next open, plus a confirmation) | C4, C5 |
| C7 | Review + verify | V | none (read-only) | C6 |
Doctor line (`menu/doctor.mjs`, "live feed: schema ok / unavailable") is an optional C5b for P.

Parallelism: C3+C4 (R) and C5 (P) run concurrently after C2 lands. Anything that touches `menu/snapshot.mjs` waits until no sweep is rebuilding it.

### Test plan (all unit tests use a TEMP sqlite the test builds; never the real DB, never the real `state/`)
Section-level lists are in A, B, C, D, E above. Whole-suite gate before each commit: `node --test test/` green; `test/bench-startup.mjs` run(5)
under the 300 ms budget; `test/contracts.test.mjs` and the two graph tests unmodified except for additions. Tests required by Revision 2 (R2-10), each with an owner above:
`observe` never calls `loadBench` at picker startup (spy on the bench read during `firstFrame`); anthropic + nvidia key derivation; `json_extract`-only SQL assertion and no
`substr(response_body_text`; kill-switch test (sentinel stops spawn, reader, `applyLive`); picker startup budget (bench-startup run(5), under +15 ms for the open-path read).
Real-data checks (read-only, run once by V after C3): `node refresh/observe-cli.mjs --catchup --dry` against the real DB: elapsed time, rows examined,
rows by skip reason, records it WOULD write, and a check that the only body-column reference is the `json_valid`/`json_extract` statement (no `substr`).
Live QA (after C5, in `docs/qa-interactive-protocol.md`): (1) run one sweep row `--only provider/id --force`, confirm the DB shows `client = 'uw-probe'`
for it; (2) with `UW_CCR_DATA_DIR` pointing at a temp dir holding a hand-made `usage.sqlite` (429 then 200 for a real key), open the picker: the row
shows `RATE`, then `OK`, `reply:` `[live ...] worked live; confirming...`, then after the probe returns `ok` with a real preview; (3) rename a column in the
temp DB: the note `live feed unavailable (schema changed)` appears and the picker still opens; (4) lock file held: no crash, no second catch-up.

### Review and verify
- Review lane (separate agents, none of them the author): `code-reviewer` on each commit; `security-reviewer` on C3/C4 for the DB read
  surface, redaction and spawn arguments (no shell, fixed argv); `critic` on this plan's state machine before C3 starts.
- Verify lane: `verifier` runs the gates above with evidence (test counts, dry-run output, startup samples) and audits against the external
  standard the project uses (the `optimal-pipeline-definition` stages), not only internal consistency.
- Deferral rule: any finding dropped from a fix round is announced to the implementer and reviewers.

### GitHub issues to file at Osamious/ultimatewrap (titles as given; file findings first, per project rule)
1. `[LIVE] usage.sqlite client column cannot separate UW probes from real use (tag probes with x-ccr-client)`
2. `[LIVE] observed.json overlay: schema, newer-wins merge in loadBench, size cap and pruning`
3. `[LIVE] read-only usage feed: schema check, id watermark, 1.5 s budget, reset detection`
4. `[LIVE] event classifier reuse and state machine (hard signals, 2-consecutive 5xx, outage and provider-wide 404 guards)`
5. `[LIVE] confirmation probe on failing->ok flip: caps, sweep-lock skip, loop safety`
6. `[LIVE] picker: uppercase stat marker, reply prefix, open-time recount, feed-status note`
7. `[LIVE] --redact / --status / --reset cover the overlay`
8. `[LIVE] docs: runbook, QA protocol, legend, C-provider-actions`
9. `[LIVE] follow-up: request_logs keeps only ~1.5 h, so provider messages are missing for older failures`
10. `[LIVE] follow-up: untagged keysync/harness scripts that call /v1/messages feed the recorder as real use (give each the uw-probe tag when it is next edited)`
11. `[LIVE] follow-up: provider-wide propagation of 401/402 (per-model today)`
12. `[LIVE] doctor: live feed check`
13. `[LIVE] persistent kill switch (state/observe.off), --status/--off/--on/--reset, and the live HH:MMZ active stamp`
14. `[LIVE] value review after C0-C3: measured weekly overlay volume decides C4 and C5`

---------------------------------------------------------------------------------------------------------

## I. Risks and open questions (ranked)

Risks
1. `x-ccr-client` may not be what fills `usage_events.client` for this route (source reading only). If it does not, probe traffic cannot be told apart and the
   recorder must NOT ship. C0 is the gate. Fallback if it fails: exclude by a `uw-probe` value in another header CCR records, or by matching bench.json record
   times (weak); the recommendation then is a dedicated gateway API key named `UW Probe` (the client falls back to the key name), a CCR config change the user decides.
2. Untagged history is mostly probes (F1, F3): reading it would mark models from sweep failures, including outage put-backs. Mitigated by the tag epoch start.
3. Fallback routing could hide a first failure: a request that failed on provider A and succeeded on B is one row for B (`provider`/`model` in usage_events are the FINAL
   attempt). CURRENTLY INERT (critic, DB): all 196 route traces say `fallback: off` and `route_attempt_count = 1`. This corrects the first draft's claim that attempts live only in a
   per-attempt body: structured sources exist (`request_logs.route_attempt_count`, `request_route_traces.attempt_count`, `$.error.attempts[]`). If fallback is ever enabled, the
   recorder should read `route_attempt_count` (a number) and skip or annotate rows where it is above 1. Documented; not built now.
4. Per-row `ok` on 200 with tokens can still be a notice with tokens. The confirmation probe (`looksLikeNotice`) is the correction; unconfirmed ok is labelled "live".
5. `node:sqlite` is experimental; a Node upgrade could change its options. Feature check + soft failure + a test pin the options used.
6. Time: the first frame never shows this open's events (about 1 s later, next keystroke). Set expectations in the runbook.
7. CCR upgrade changes `usage_events` or `x-ccr-client` handling: schema check fails soft; doctor drift line.
8. Spend: at most 10 confirmations per day, 3 per catch-up, one per key per 6 h, row cost <= $0.01 (the economy ceiling), never for `anthropic`. Free routes dominate.
9. Value (R2-9): the feed may produce few records per week. Mitigation: the staged build and the value review in H.
10. Privacy regression (R2-1): any later edit that reads a body column in JS re-opens the leak. Mitigation: the single `readFailureText` function and the grep/SQL-text tests.

Open questions for the user (final, after the critique; the coordinator's answers are recorded)
- ANSWERED, no longer open: I1 accepted with the "provider had an ok in the last 14 days" condition; I2 no history ingest; I3 410 -> gone, 422 and 413 ignored, 400 ignored unless the
  message says otherwise; I4 replaced by the 2-minutes-apart / within-24-h rule; I5 per model only; I6 no spend for unknown models; I7 UPPERCASE stat, no separate column; I8 deferred.
- REAL DECISIONS LEFT FOR THE USER:
  1. Build order: after C0-C3 is the value review (H) acceptable as a gate before C4/C5, or do you want the full feature built regardless? Recommendation: gate it.
  2. If C0 shows `x-ccr-client` does NOT fill `usage_events.client`: accept a dedicated CCR gateway API key named "UW Probe" (a CCR config change) or drop the feature? Recommendation: the key.
  3. Where should the persistent switch live: the sentinel file `state/observe.off` (recommended: no source edit, visible in a directory listing) or a field in the picker's settings file?



---------------------------------------------------------------------------------------------------------

## Revision 2: changes from critique

Independent critic verdict: REVISE. Every change below is already applied in the body above; this list is the index. Evidence is from the critic's
verification against the CCR bundle and the databases, plus the read-only re-measurements marked (re-measured) (schema and aggregates only; no body,
prompt, reply, key or credential text was selected or printed).

| ID | Change | Where | Evidence |
|---|---|---|---|
| R2-1 | PRIVACY. The 2,048-char prefix of `response_body_text` is dropped. Messages come only from `case when json_valid(response_body_text) then json_extract(response_body_text,'$.error.message') end` (plus `$.error.code/type/status` for in-memory classification). The body never enters JS. No prefix or raw-text fallback: fallback text is `HTTP <status> (provider message not kept)`. SQL-text test asserts `json_valid` + `json_extract` + `'$.error.message'` and that no `substr(response_body_text` exists under `refresh/`. | F6, B (Joined message, Tests), F | Critic: 4 google rows embed `candidates[].content.parts[].text` at offsets 462-786; a 499 anthropic body is an assistant message object; 34 of 163 prefixes cut mid-JSON. (re-measured) 155 of 164 non-200 bodies are valid JSON, all 155 have `$.error.message`; `json_extract` on invalid JSON throws, so the `json_valid` CASE guard is mandatory. |
| R2-2 | CLASSIFICATION INPUT. `classifyHttp`/`QUOTA`/`PLAN_STRICT`/`saysGone` run on the raw text: the reader classifies inside itself on the SQL-extracted full message plus code/type/status, in memory, never stored; only the redacted 160-char clip becomes `m`. | B step 4 | bench.mjs: "classification always reads the raw body"; a clip loses decisive tokens. Test: decisive phrase beyond char 160 still classifies `pay`. |
| R2-3 | KEY DERIVATION. Try `provider/model` against the snapshot; if absent and `model.startsWith(provider + "/")`, try the stripped form. Tests for anthropic and nvidia. The anthropic route is observed but NEVER auto-confirm-probed (spends subscription quota). Drift tripwire: more than 50% of examined non-anthropic rows `unknownKey` -> feed note `key mapping changed`. | B step 1, D gate (0) | (re-measured) `model` starts with `provider/` on 46,152 of 69,971 usage rows; anthropic 58,380 rows; non-anthropic prefixed 2,383; nvidia 80 rows differ (critic). |
| R2-4 | STARTUP READ. `applyLive` no longer calls `loadBench`. The child computes per-provider `bench`/`benchFlags`/`benchAgeHist` (+ `live`, `liveOk`) with `bakeBench` over the merged view and stores it in observed.json as `prov`, stamped `writtenAt`. The picker's startup step reads only observed.json (~1 ms) and applies `prov` when `writtenAt > builtAt` (writtenAt vs builtAt, not event time vs builtAt). Level-0 counts and level-1 rows agree by construction (same merge), with a test. | C (shape, `prov`), E (Provider-level counts) | `test/bench-view.test.mjs` ~410/421 assert bench.json is not read at startup and one `loadBench` call site. |
| R2-5 | TWO-CONSECUTIVE RULE redefined: two ambiguous failures at least 2 minutes apart (or different 5-minute buckets), no more than 24 h apart, no 200 between. Retry bursts are ignored. Gateway-synthesized empty-body 502s count as ambiguous network failures. Batches are sorted by completion time then id within a run (CCR `backfillFromRequestLogs` can insert older rows with new ids). `pend` expires at 24 h (was 3 days). | B state machine, C pruning | Critic: 840 same-key consecutive 5xx pairs, 31% within 10 s, 47% within 60 s, median 110 s. (re-measured) 854 pairs, 20% within 10 s, 37% within 60 s, 44% within 120 s, median 156 s, 98% within 24 h (same direction, different pairing details). |
| R2-6 | PRECONDITION / OWNERSHIP. C1 does not start until the 31 uncommitted picker changes under `menu/` and `test/` are committed; C2/C5 are rebased on them. The `loadBench` merge lands behind the enable switch, default OFF until C5 removes the sentinel. | H (PRECONDITION, C1, C2, C5 rows) | git status at plan time: 31 modified files under docs/menu/test. |
| R2-7 | KILL SWITCH AND VISIBILITY. Persistent sentinel `state/observe.off` (`observe-cli --off` / `--on`) that both stops the spawn and makes every reader ignore the overlay (`UW_OBSERVE=0` is kept but is not sufficient because the picker launches via a Claude Code wrapper). `observe-cli --status` prints enabled, last run, watermark, counts, feed, last error. An active `live HH:MMZ` stamp in the header/legend whenever overlay records are merged. `--reset` and the sentinel path documented in the runbook. | A (kill switch, visibility), C (enable switch), E (active marker), G, H | Tests: kill switch stops spawn, reader and `applyLive`. |
| R2-8a | Confirmation cost ceiling is `ECONOMY_DEFAULTS.maxRowCost` = $0.01 (was $0.10); `conf[key]` set at SPAWN time under the lock. | D | |
| R2-8b | Confirm child retries `observed.lock` for at least 3 s (100 ms polls), not 5 x 50 ms. | C (Lock) | |
| R2-8c | `ranAt` removed from observed.json (only `writtenAt`); observed.json is written only on content change; per-run bookkeeping in `state/observed.run` (launch gate reads its mtime), so the picker's mtime reload does not fire every open. | C | |
| R2-8d | Child watchdog `setTimeout(process.exit, 10_000).unref()` (confirm 60 s) and a sweep of stale `observed.json.tmp-*` older than 5 minutes at child start. | A, G | |
| R2-8e | EPERM/EBUSY rename retry: `writeAtomic` has none (it removes its tmp and rethrows), so the retry is a new `writeAtomicRetry` in `refresh/observe.mjs` (`menu/atomic.mjs` is not edited: it is on the picker's graph). The picker's `statSync` is wrapped in try/catch. | C (Lock), E | menu/atomic.mjs read at plan time. |
| R2-8f | AGE CREDIT from probe records only: `get.stamp` returns the probe record's `a` (null for an overlay-only key), so a live flip does not refresh `oldest probe` or hold back the outdated notice. Header ok totals state both populations (`ok 812 (2 live)`). This reverses the first draft's "a live record counts as a record for age". | C (Merge), E | Project rule: counts carry their denominator. |
| R2-8g | Uppercase-marker test covers all 8 status codes at width 4 (upper and lower). | E (marker, tests) | |
| R2-8h | I1 (404 downgrade) also requires the provider to have had an ok in the last 14 days, otherwise the 404s stay `gone`. | B state machine, G | Critic: 0 of 954 keys that ever returned 404 later returned 200. |
| R2-8i | Untagged keysync/harness scripts feed the recorder as real use: recorded as issue 10 (tag each when next edited). Their outcomes are valid observations, so this is a follow-up, not a blocker. | H (issues) | |
| R2-8j | Fallback-routing blind spot corrected: it is currently inert; the claim that attempts live only in a per-attempt body was wrong; structured sources are `request_logs.route_attempt_count`, `request_route_traces.attempt_count`, `$.error.attempts[]`. | I risk 3 | Critic: 196 of 196 route traces `fallback: off`, `route_attempt_count = 1`; usage_events `provider`/`model` are the FINAL attempt. |
| R2-9 | VALUE PROPOSITION stated: expected signal is thin; the feature mostly reports the anthropic subscription route plus occasional free-model use. Recommendation: build C0-C3 first, run the feed for about two weeks with the merge OFF or shadow-only, measure records per week and disagreements with bench.json, then decide C4 and C5 (new issue 14). | H (STAGING AND VALUE GATE), I risk 9 | Critic and (re-measured): 2,402 non-anthropic usage rows across 2026-09-01..09-28; 9,189 of 13,535 rows on 09-29 were sweep/keysync probes. |
| R2-10 | Tests added: observe never calls `loadBench` at picker startup; anthropic + nvidia key test; `json_extract`-only SQL assertion (and no `substr(response_body_text`); kill-switch test; picker startup budget (under +15 ms). | B, C, E tests, H test plan | |

Open questions after Revision 2: the coordinator's answers to I1-I8 are recorded in section I. Three real decisions remain for the user (build order gate,
the dedicated-key fallback if C0 fails, and where the persistent switch lives).


---------------------------------------------------------------------------------------------------------

## Overlay shape as implemented (C3, refresh/observe.mjs)

Written by the C3 implementer for the picker agent (C2 reader, C5). Where this differs from section C above, THIS is what the file contains.

```
{
  "schema": 1,
  "writtenAt": "<ISO>",       // when this CONTENT was written; unchanged while the content is unchanged
  "feed": "ok",               // ok | warn:key-mapping | unavailable:schema | unavailable:missing | unavailable:locked | unavailable:node-sqlite
  "prov": { "<keyId>": { "bench": {...}, "benchFlags": {...}, "benchAgeHist": [...], "live": 2, "liveOk": 1 } },   // ABSENT (no key) until bakeBench exists; see below
  "wm":   { "id": 70409, "seq": 70409, "at": "<created_at of row id>" },      // null before the first run; seq may be null
  "tagId": 69412,             // first id of a uw-probe row seen, or null
  "models": { "<provider>/<id>": { ... } },
  "pend":   { "<key>": { "n": 1, "s": "error", "a": <epoch s>, "q": "<request id>" } },
  "conf":   {},               // C4 fills it; C3 always writes {}
  "confDay": { "d": null, "n": 0 }   // C4 fills it; C3 always writes this
}
```
Key order is fixed as above (`schema, writtenAt, feed, [prov], wm, tagId, models, pend, conf, confDay`).

- `stats` is NOT in observed.json (R2-8c wins over the section C sample: `ms` changes every run and would force a rewrite). Per-run bookkeeping is in
  `state/observed.run`: `{ ranAt, ms, error, feed, examined, skip, written, wrote, lockedRuns, reset, provSeam, confirm }`. The launch gate reads its mtime.
- `wm` changes whenever rows were examined, so observed.json IS rewritten (and `writtenAt` moves) on a run that examined new rows even if no
  record changed. A run that examined nothing new writes nothing. The picker's mtime reload therefore fires at most once per open that saw new router traffic.
- Records in `models`, exactly (all times epoch seconds): 
  - live ok: `{ s:"ok", d, a, q, l:1, o }`; when it is a failing -> ok flip of a benched, non-anthropic key also `cf:1, cfa:<epoch s the flip was seen>`.
    Never `cf` for a key with no earlier record or for provider `anthropic`. `t, r, p, v` are absent (a confirmation, C4, adds `v:1` and the probe's `t, d, r, o, p`).
  - live failure: `{ s: rate|pay|auth|gone|error|timeout, d, a, q, l:1, m }`. No `o`, no `p` (the reader derives `p` from `m`). `m` is the 160-char redacted provider
    sentence, or `HTTP <status> (provider message not kept)`, or, for a satisfied two-failure rule, `2 failures >= 2 min apart, no 200 between: HTTP <status>`, or
    `404 across N models of <provider>: path or base URL?` for the provider-wide 404 downgrade.
  - `a` = completion time of the request (`created_at + duration_ms`), `q` = request id (sanitized, max 40), `d` = duration in ms (integer).
- `prov` is written ONLY when a `bakeBench(row, get, nowMs)` export exists in `menu/snapshot.mjs` or `menu/bench-data.mjs` (the engine imports it dynamically at run
  time; nothing needs to change in refresh/ when the picker agent adds it). `row` is the snapshot row (`keyId, provider, models[]`); `get` is the merged view
  (newer `a` wins, tie to the probe; `get.stamp` is probe-only, `get.records` a number). It returns `{ bench, benchFlags, benchAgeHist }`, stored with `live` (routes whose
  winning record is live) and `liveOk` (of those, how many are `ok`), only for providers that have at least one overlay record. Until the export exists the key is absent.
- Pruning at every write: keys not in the snapshot, entries whose `a` is not newer than the probe record, entries older than 14 days, then above 800 the oldest;
  `pend` older than 24 h; `conf` older than 7 days.
- A feed problem does not erase records: on `unavailable:*` only `feed` is updated in an existing overlay (created fresh with empty `models` for `schema` and `node-sqlite`
  only). `unavailable:locked` is set only after 3 consecutive locked runs. `warn:key-mapping` needs at least 10 examined non-anthropic rows.
- The reader may rely on: `models` is always an object; `pend`, `conf` may be `{}`; `prov` and `wm` may be absent/null; unknown extra keys should be ignored.
- Decisions taken where the plan was silent: an event whose `a` is not newer than the effective (probe or overlay) record is dropped as `stale`; an ambiguous failure on a key
  that is already `error`/`timeout` follows the same 6 h duplicate rule as a hard one (no write per event); `--backfill-days N` is an explicit first-run override that starts
  N days back and ignores the tag rule (for `--dry` measurements); a request id seen twice in one run counts once.

### C4 additions to the overlay shape (refresh/observe.mjs, `observe-cli --confirm`)

No new top-level field. `conf` and `confDay` are now filled; `cf`/`cfa`/`v` on a record carry the meaning below.
- `conf`: `{ "<key>": <epoch s> }`. Set by the CATCH-UP at spawn time (a reservation, in the same write as the records); a confirm child that skips BEFORE sending anything
  (sweep running, no gateway settings, gateway not answering /health) deletes it again and decrements `confDay.n`, so the next open may retry; after a probe it is set to the
  probe's time. One confirmation per key per 6 h. Entries older than 7 days are pruned.
- `confDay`: `{ "d": "YYYY-MM-DD" (UTC), "n": <reservations today> }`; at most 10 a day; rolls over when `d` is not today.
- A record awaiting confirmation: `{ s:"ok", d, a, q, l:1, o, cf:1, cfa:<epoch s the flip was seen> }`. Only for a benched, non-anthropic key that had a non-ok record. It is
  a candidate for a confirmation for one hour after `cfa`; the picker should show it as plain live after 2 minutes (plan E), the file does not clear `cf` by itself.
- CONFIRMED record (probe said ok): `{ s:"ok", t, d, r, o, p, k?, x?, m?, b?, a:<probe time>, l:1, v:1, q:<the flip's request id> }`. `t`, `d`, `r`, `o`, `p` (redacted, <= 120 chars) and
  `k` (1 when the preview is thinking), `x`, `m`, `b` are the probe's (only the fields that carry information, exactly `toStored`'s list); `cf` and `cfa` are gone.
- OVERRULED record (the probe said auth, pay, gone, empty, or delivered a notice as a 200 that classified as any class): `{ s:<the probe's class>, d, p?, m?, a:<probe time>, l:1, v:1, q }`.
  `v:1` means "verified by our own probe" for either outcome. `cf`/`cfa` are gone.
- A TRANSIENT probe outcome (rate, error, timeout on a non-200) does NOT replace the live ok: the record is the flip record with `cf` and `cfa` removed, no `v`, and `conf[key]`
  set so it is not probed again inside 6 h.
- An aborted probe, a busy lock (3 s of retries) or a record replaced by a newer event leaves the file as it was; `cf:1` then simply ages out to plain live.
- `prov` is recomputed after a confirmation write when `bakeBench` exists, exactly as in a catch-up.

### Review-round changes to the overlay shape and rules (refresh/observe.mjs)

- `m` is the provider's sentence ONLY for statuses 401, 402, 403, 404, 410 and 429. Every other status (400/413/422, all 5xx, including a record whose class came from a tight text
  anchor) stores the fixed text `HTTP <status> (provider message not kept)`, because their bodies can echo the conversation (validation errors quote the input). The full text is
  still used, in memory only, to classify.
- Non-hard statuses take a hard class only from TIGHT anchors (`classifyTight` in refresh/bench.mjs: an empty balance said in words, an account-state sentence, a strong "this model is
  gone" phrase or machine code). 400/413/422 otherwise stay ignored; a 5xx otherwise stays ambiguous (two failures >= 120 s apart), even when its text says rate limit.
- Two-failure rule: only the 120 s gap counts (the "different 5-minute buckets" clause is gone). Outage guard: a sliding 60 s window (3+ providers, no ok within a minute of the span).
- NEW optional top-level field `confHold`: an epoch second. A confirm child that could not reach the gateway (no settings, /health not answering) or found a sweep running hands its
  reservation back and sets `confHold = now + 600`; no confirmation is requested (and nothing is rewritten) until then; the catch-up drops the field once it has passed. Absent normally.
  The reader may ignore it. Key order: `..., conf, confDay, [confHold]`.
- An overlay that exists but cannot be READ (EBUSY, EPERM, antivirus) skips the run (`observed.run`: `reason: "overlay-unreadable"`, `error: "overlay-unreadable: <code>"`); only a MISSING
  file is a first run. A damaged overlay is healed on read (`pend`, `conf`, `confDay` coerced), and a damaged snapshot (null rows, `models` not an array) is normalized.
- The failure text query is gated on `response_body_size_bytes <= 262144` before any parse, and at most 200 failing ids are read per run (the rest keep the fixed text).
- `--status` prints only sanitized strings; two mode flags on one command line are an error (exit 2); the confirm child's watchdog is 90 s.
- `prov[keyId].live` = routes whose winning record is a live observation (any `l:1` record, verified or not); `prov[keyId].liveOk` = of those, the `ok` ones WITHOUT `v:1`
  (a probe-confirmed record draws lowercase and is a probe measurement, so it is not an "unverified live ok"). The header's `(n live)` is `liveOk`.
- `state/observed.run` is stamped FIRST in every non-dry run, before anything can fail: `{ ...previous contents, ranAt }` (content-minimal, so the last error and counts survive a
  crash) and again at the end with the run's facts. So every exit path (missing DB, schema change, bad snapshot, unreadable overlay, busy lock, crash) moves its mtime, which is what
  the picker's launcher throttles on. The only silent exit is the kill switch (`observe.off`): it touches nothing. `--dry` writes nothing.

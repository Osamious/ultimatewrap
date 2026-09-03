# Security review: the proposed catalogue system (2026-09-02)

Scope: 44-provider model-catalogue system (periodic `/v1/models` fan-out → local cache →
two-level TUI → writes to `~/.claude/settings.json` `modelPicker` + CCR `config.sqlite`),
reviewed against the existing implementation in `~/.uw/keysync/`, the vault at `~/.llmkeys/`,
CCR's live artifacts, and the UW plan.

**Risk level: HIGH** — one genuinely exploitable, silent, third-party-triggerable routing
hijack (F1), plus a logging path that would materially widen the already-accepted
plaintext-key tradeoff.

Counts: Critical 1 · High 5 · Medium 5 · Low 2. Explicitly assessed and found **not** a real
risk: JSON injection into `settings.json` (F3d).

**Baseline that must not regress:** the existing write path is unusually careful —
`atomicWriteJson` (temp+rename with DACL capture/reapply, `safety.mjs:353-382`), WAL-safe
DPAPI-encrypted `config.sqlite` snapshots (`safety.mjs:47-73`), an atomic
`openSync(...,"wx")` single-writer lock (`safety.mjs:162-200`), merge-never-reconstruct of
`settings.json` (`run.mjs:442-468`), post-write verification (`run.mjs:471-473`). Keys are
read in one batched PowerShell call with only **ids** on the command line, never values
(`run.mjs:49-58`). `last-test-results.json`, `verified-rows.json` and `built-rows.json` were
scanned and contain **zero** secret-shaped strings. Every mitigation below should be added
*inside* this machinery, not alongside it.

---

## CRITICAL

### F1. Provider-controlled model lists convert an existing WARNING into a live, silent prompt-exfiltration hijack

**Category:** A03 Injection / A08 Integrity Failures.
**Location:** `run.mjs:163-187` (bare-id guard), `keysync.mjs:193-205` (model selection/ranking).
**Exploitability:** Remote — any one of the 44 upstreams triggers it purely by changing its
own `/v1/models` output. No local access needed.
**Blast radius:** Claude Code's default traffic (full system prompt, tool definitions, file
contents read into context, and responses) silently routed to an attacker-chosen provider.

The existing code already documents the mechanism, and states the current safety is
*contingent*:

> `run.mjs:151-157` — "the safety of a built-in row is a property of `Providers[]`, not of
> anything keysync controls — and it changes silently whenever provider coverage changes.
> **MEASURED 2026-09-02: safe in every current configuration** … This guard exists because
> that result is contingent, not structural."

Today the contingency is bounded because `Providers[].models` comes from two **locally
controlled** sources: `vp.testModel` (hand-authored) and CCR's bundled `models.json`. The
proposed design replaces both with a list the *remote provider writes* — the exact input the
guard says it cannot control.

The ranking rule makes the hijack **deterministic rather than lucky**:
```js
// keysync.mjs:196-199 — free-tier first, then shortest id
.sort((a, b) => (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) ||
                 a.m.model.length - b.m.model.length);
```
A hostile aggregator publishes `{"id":"opus","pricing":{"input":0,"output":0}}`. `inferTier`
returns `"free"`, it sorts first, and it lands inside `MAX_MODELS_PER_PROVIDER = 3`. If it is
the unique provider listing that bare name, CCR's cross-provider fallback binds Claude Code's
built-in rows to it. The guard only `console.warn`s — right for a curated list, wrong for a
remote one.

Not hypothetical for this vault: a large fraction of the 44 are small aggregator/reseller
hosts with no meaningful security assurance — `routllm.pro`, `seekai.cc`, `tabitoken.com`,
`ineed.web.id`, `gorouter.app`, `api.teamorouter.com`, `tokenharbor.ai`, `router.bynara.id`,
`apihub.agnes-ai.com`, `api.commandcode.ai`, `zenmux.ai`, `api.kilo.ai`.

**Remediation:**
```js
// BAD — remote list straight into Providers[].models
const models = (await fetchModelList(provider, key)).data.map(m => m.id);

// GOOD — reserved-name denylist enforced BEFORE use
const RESERVED = /^(claude|opus|sonnet|haiku|fable)([-._\d]|$)/i;

function admitRemoteModels(providerName, remoteIds) {
  const kept = [], rejected = [];
  for (const raw of remoteIds) {
    const id = String(raw);
    if (providerName !== "anthropic" && RESERVED.test(id)) { rejected.push(id); continue; }
    kept.push(id);
  }
  if (rejected.length) {
    console.warn(`SECURITY: provider "${providerName}" advertised ${rejected.length} ` +
      `reserved Anthropic-shaped model name(s); rejected: ${rejected.join(", ")}`);
  }
  return kept;
}

// AND: make the existing run.mjs guard FATAL once lists are remote-sourced.
if (hijackable.length) {
  throw new Error(`refusing: ${hijackable.length} bare Claude-shaped id(s) are uniquely ` +
    `owned by a non-Anthropic provider (${hijackable.map(([n]) => n).join(", ")}).`);
}
```

Additionally: pin `replaceBuiltInOptions: true` and never ship a bare, unnamespaced id. Every
row keysync writes is already namespaced (`${name}/${m.id}`); the exposure is entirely via
Claude Code's *surviving built-in* rows, so the denylist is the load-bearing control.

---

## HIGH

### F2. Routing catalogue fetches through the CCR gateway would write provider responses — and any key-in-URL — into an unbounded, unpruned log store

**Answer to "which path is safer": fetch directly from the refresher. Do not route catalogue
fetches through the gateway.** Three measured reasons:

1. **`request_logs.url` is stored unredacted.** The live schema has
   `url TEXT NOT NULL DEFAULT ''` alongside `request_headers TEXT` and
   `response_headers TEXT`. Sampling 40 live rows confirmed CCR *does* redact auth headers
   (`x-auth-api-key-id -> REDACTED`, `x-auth-sub -> REDACTED`, no `authorization` key at
   all). **Headers are handled; the URL is not.** Any provider whose model-list endpoint
   carries the key in the query string writes it to disk in cleartext. Real here: `google` is
   configured as `https://generativelanguage.googleapis.com/v1beta/openai`, and Google's
   *native* model-list endpoint is `…/v1beta/models?key=<API_KEY>`.
2. **The capture policy is error-biased, and a 44-provider fan-out is error-dominated.**
   `run.mjs:278-283` sets `requestLogBodyCapture: "errors"` with
   `requestLogSuccessSampleRate: 0.05`. Only **14 of 44** providers actually serve — so ~⅔ of
   every sweep is a 401/402/403/404, i.e. exactly the population captured **verbatim at
   100%**. Provider error bodies routinely echo the submitted credential (OpenAI's
   `Incorrect API key provided: sk-…` being canonical). The 43 currently-captured error bodies
   contain zero secret-shaped tokens — but that sample is chat traffic, not authentication
   failures against 30 misconfigured upstreams.
3. **There is no retention.** `request-logs.sqlite` is 160 MB, its WAL 4.8 MB,
   `request-log-bodies/` 47 MB — consistent with the plan's Finding 16.

**Remediation:**
```js
// GOOD — direct, https-only, no redirects, key in a header, never in the URL
async function fetchModels(baseUrl, key, headersTemplate) {
  const u = new URL("models", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  if (u.protocol !== "https:") throw new Error(`refusing non-https model-list URL: ${u.origin}`);
  if (u.search) throw new Error(`refusing model-list URL with a query string: ${u.pathname}`);
  const res = await fetch(u, {
    method: "GET",
    redirect: "manual",              // never replay the credential to a redirect target
    headers: { ...buildHeaders(headersTemplate, key), Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`provider redirected model-list request (${res.status}); refusing to follow`);
  }
  return res;
}
```
`redirect: "manual"` is essential — Node's `fetch` defaults to `follow`, and **forwards the
`Authorization` header across same-scheme cross-origin redirects on some runtimes.**

### F3. Terminal escape-sequence injection from provider-controlled model ids and labels

**Location:** proposed TUI render path; today's sink is `keysync.mjs:223-237` and
`run.mjs:191`.
**Blast radius:** spoofed UI (a row rendered to look like `Anthropic > claude-opus-5`),
cursor/scrollback manipulation to hide the real selection, and on terminals with OSC-52
enabled, clipboard write.

Today there is **zero** validation: `keysync.mjs:212-237` takes `m.model` straight into
`` `${name}/${m.id}` `` and `` `${name} > ${m.id}` ``. The bundled catalog happens to be
clean — all 4,298 entries checked: **0 ids outside `[A-Za-z0-9._:@/-]`, longest id 50
chars** — but that is a property of today's data, not an enforced invariant.

- **(a) Escape sequences — REAL.** `\x1b[2J`, `\x1b[1A`, `\r`, `\x1b]52;c;<b64>\x07` all pass through `console.log` and any naive TUI writer untouched.
- **(b) Extremely long strings — REAL but MEDIUM.** Garbles the TUI; more importantly inflates `settings.json`, which CC parses at every launch. `MAX_MODELS_PER_PROVIDER = 3` currently bounds this; **do not lift it when the source becomes remote.**
- **(c) Path separators / shell metacharacters — REAL, and ids legitimately contain `/`.** `groq/openai/gpt-oss-20b` is a valid two-slash id (current picker row: `groq/groq/openai/gpt-oss-20b`). So `/` cannot be banned — but `\`, `..`, NUL, and anything reaching a filesystem path must be. **Never build a cache path from a remote id; hash it.**
- **(d) JSON injection into `settings.json` — NOT a real risk.** `atomicWriteJson` uses `JSON.stringify(obj, null, 2)` (`safety.mjs:360`), which escapes control characters and quotes structurally. Called out explicitly so effort is not spent here.

**Remediation — one allowlist, at ingest, rejecting rather than sanitizing:**
```js
const MODEL_ID_OK = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;   // no \, no .., no controls

function admitId(providerName, id) {
  const s = String(id ?? "");
  if (!MODEL_ID_OK.test(s)) return null;
  if (s.includes("..")) return null;
  return s;
}

const CTRL = /[ --  ]/g;
const displayText = (s, max = 80) => String(s ?? "").replace(CTRL, "").slice(0, max);
```
Sanitizing keeps an attacker-shaped id in the routing table; rejecting does not.

### F4. Scheduled rewriting of `settings.json` risks silently degrading the agent's security posture

`settings.json` is not a preferences file. It holds **20 top-level keys**, including
`permissions: {"defaultMode":"auto"}`, `skipDangerousModePermissionPrompt: true`,
`skipAutoPermissionPrompt: true`, 18 `enabledPlugins`, `extraKnownMarketplaces`, a
`statusLine` that executes `node …\omc-hud.mjs` on every render, and a large
`autoMode.environment` block encoding the entire trust boundary (trusted repo, sensitive data
locations, protected deployment namespaces, "treat public paste/gist services as outside the
trust boundary"). **Losing `autoMode.environment` while `defaultMode` stays `"auto"` silently
removes the policy governing auto-approval, with no visible symptom.**

The current implementation re-reads and merges rather than reconstructing, and a live run
preserved all 19 pre-existing keys byte-identically. But post-write verification is
**presence-only**:
```js
// run.mjs:472 — checks three fields exist; blind to 17 others going missing
const ok = final.apiKeyHelper && final.env?.ANTHROPIC_BASE_URL && final.modelPicker?.options?.length;
```
Moving from an operator-run command to a **schedule** removes the human who would notice.

**Invariants to assert around every write:**
```js
const SECURITY_CRITICAL = ["permissions","hooks","enabledPlugins","extraKnownMarketplaces",
                           "statusLine","apiKeyHelper","autoMode","skillOverrides",
                           "skipDangerousModePermissionPrompt","skipAutoPermissionPrompt"];
const OWNED = new Set(["modelPicker", "model"]);   // the ONLY keys this tool may change

const digest = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0,16);

// BEFORE
const before = JSON.parse(fs.readFileSync(SETTINGS,"utf8").replace(/^﻿/,""));
const beforeKeys = new Set(Object.keys(before));
const beforeSec = Object.fromEntries(SECURITY_CRITICAL.filter(k=>k in before).map(k=>[k,digest(before[k])]));

// ... merge modelPicker, then atomicWriteJson(SETTINGS, settings) ...

// AFTER — fail loudly and roll back on ANY drift outside the owned keys
const after = JSON.parse(fs.readFileSync(SETTINGS,"utf8").replace(/^﻿/,""));
for (const k of beforeKeys) if (!(k in after)) throw new Error(`post-write: key "${k}" LOST`);
for (const [k,h] of Object.entries(beforeSec))
  if (digest(after[k]) !== h) throw new Error(`post-write: security-critical key "${k}" MODIFIED`);
for (const k of Object.keys(after))
  if (!beforeKeys.has(k) && !OWNED.has(k)) throw new Error(`post-write: unexpected new key "${k}"`);
```
The `throw` lands in the existing `catch` at `run.mjs:480`, which already calls
`restoreSettings`. Also raise `keepSettings` in `retainOnSuccess` (`safety.mjs:106`) from
**1 to at least 5** for a scheduled writer: with one backup, two bad runs destroy the last
good copy.

### F5. Key material for 44 credentials held in memory for the lifetime of a long-running refresher

Current exposure is seconds: a CLI loads 44 keys into `keyCache`, writes config, exits.
Making the refresher **scheduled and resident** changes the profile — the accepted tradeoff
was scoped to *"any local code already running as this user … that obtains the RPC token"*,
i.e. an attacker who must find the token. A resident process holding a plaintext `{id: key}`
object extends that to anything that can open the process or read a dump.

```js
// GOOD — batch-load for the sweep, then zero and drop
async function withKeys(ids, fn) {
  const cache = loadAllKeys(ids);
  try { return await fn((id) => cache[id]); }
  finally {
    for (const k of Object.keys(cache)) cache[k] = "\0".repeat(cache[k].length);
    for (const k of Object.keys(cache)) delete cache[k];
  }
}
```
Also disable crash dumps: ensure no `--report-*` flag is inherited (a Node diagnostic report
serializes the heap-adjacent environment). Run under the **user** account, never SYSTEM.

### F6. `providers.json` is a tamperable SSRF / credential-replay surface, and protocol resolution is substring-based

`providers.json` is unsigned and user-writable, and the pipeline trusts it completely.
`resolveProtocol` takes `vaultProvider.baseUrl` and returns it verbatim for the OpenAI path
— **no scheme check, no host allowlist**. All 47 current entries are `https://` with no query
string and all 44 filtered ones use an `Authorization` header — but nothing *enforces* that.
Change one `baseUrl` to `http://attacker/` and the next unattended refresh POSTs a live key
to it.

Separately, protocol resolution matches on **substring, not host**:
```js
// keysync.mjs:106-108 — matches https://evil.example/anthropic/ as "anthropic"
if (base.includes("anthropic")) {
  return { type: "anthropic_messages", baseUrl: vaultProvider.baseUrl };
}
```
No current entry triggers it (zero providers match), so it is latent — but wrong by
construction.

```js
// GOOD — parse, validate scheme, match on HOST
export function resolveProtocol(vaultProvider) {
  let u;
  try { u = new URL(vaultProvider.baseUrl); }
  catch { throw new Error(`provider "${vaultProvider.provider}": unparseable baseUrl`); }
  if (u.protocol !== "https:")
    throw new Error(`provider "${vaultProvider.provider}": non-https baseUrl — refusing to send a credential`);
  const host = u.hostname.toLowerCase();
  const hostIs = (d) => host === d || host.endsWith("." + d);
  if (hostIs("generativelanguage.googleapis.com"))
    return { type:"gemini_generate_content", baseUrl:"https://generativelanguage.googleapis.com/v1beta" };
  if (hostIs("anthropic.com"))
    return { type:"anthropic_messages", baseUrl:vaultProvider.baseUrl };
  return { type:"openai_chat_completions", baseUrl:vaultProvider.baseUrl };
}
```
Pair with a **pinned host allowlist committed next to the code** (not in the tamperable
JSON): a `Map<provider, expectedHost>` asserted every run.

**On CCR's proxy subsystem:** `gateway-proxy-preload.cjs` patches `globalThis.fetch` to route
through `ProxyAgent(CCR_UPSTREAM_PROXY_URL)` unless `NO_PROXY` matches, with loopback always
bypassed and unparseable URLs failing *closed*. That logic is sound. The risk is
**inheritance**: if the refresher is launched as a child of, or with the environment of, the
CCR gateway, its 44 authenticated requests silently traverse whatever
`CCR_UPSTREAM_PROXY_URL` points at. **Launch the refresher with a scrubbed environment** —
explicitly delete `CCR_UPSTREAM_PROXY_URL`, `HTTPS_PROXY`, `HTTP_PROXY`, `NODE_OPTIONS`,
`NODE_EXTRA_CA_CERTS`.

---

## MEDIUM

### F7. The cache is a low-value asset by content but a high-value *inventory*

Three distinct disclosures:
1. **Provider-holdings inventory** — a cache listing 44 providers with per-provider success/failure maps exactly which services hold paid credentials and which are live. Bucket names themselves encode affiliations (`tamu`, `sportsvector`, `sportsvector1-3`, `personal_maestro`, `personal_mxene`).
2. **Org/account identifiers** — real: `providers.json` already stores `accountInfo` for 7 providers containing exactly this class (`alibaba.DASHSCOPE_WORKSPACE_ID`, `cloudflare.accountId`, `chutes.loginFingerprintId`, `nousresearch.org`, `youcom.platform`). Several providers return equivalents in `/v1/models`.
3. **Quota/tier inference** — storing per-model rate-limit or credit fields turns the cache into a live balance sheet.

```js
// GOOD — explicit allowlist projection at ingest. Never persist the raw response.
function projectModel(providerName, raw) {
  const id = admitId(providerName, raw.id ?? raw.name);
  if (!id) return null;
  return {
    id,
    contextTokens: Number.isInteger(raw.context_length) ? raw.context_length : undefined,
    modality: Array.isArray(raw.modalities)
      ? raw.modalities.filter(m => ["text","image","audio","video"].includes(m)) : undefined,
    tier: inferTier(raw)      // derived locally, then the pricing itself is dropped
  };
}
```
**Explicitly discard:** the raw body; `organization`/`owned_by`/`account_id`/`workspace`/
`tenant`/`owner`/`created_by`; every response header (especially `x-ratelimit-*`,
`openai-organization`, `cf-ray`, `set-cookie`); any `key`/`token`/`credential` field; any URL
the provider returns; balances/credits/quotas; and the raw error body — keep only the numeric
status and a fixed enum.

**Cache hygiene:** store under `%LOCALAPPDATA%` with the owner-only DACL the existing code
already sets (`ensureBackupDir`'s `icacls … /inheritance:r /grant:r`). Do **not** put it in
`~/.llmkeys` or any directory that could become a repo.

### F8. Unattended scheduled refresh materially widens exposure

Five new exposures, all from removing the human:
1. **No witness.** F4, F6 and F1 all currently have an operator watching `console.warn`. Warnings nobody reads are not controls.
2. **Silent failure accumulation.** `restoreSettings` failing leaves settings unrestored with only a `console.error`. On a timer, that repeats.
3. **Repeated polling of a compromised endpoint.** A hostile upstream gets N authenticated probes per day and can time a change for 03:00.
4. **Key-liveness oracle.** Clockwork requests confirm to all 44 that the key is live and unattended.
5. **The `--i-know` gate is bypassed by construction.** A scheduler supplying it on every invocation converts a consent gate into a constant.

**What should NOT be built as described: do not schedule anything that writes
`settings.json` or `config.sqlite`.** Split:
```
refresh  (schedulable)  — fetch + validate + write cache ONLY. Never touches settings.json,
                          config.sqlite, or the gateway. Exits non-zero on validation
                          rejection and writes a machine-readable status file.
apply    (manual only)  — reads the cache, shows a diff of what CHANGED since the last apply
                          (new providers, new ids, and above all any reserved-name
                          rejections from F1), then writes. Keeps --i-know as a real gate.
```
Whatever the schedule, add **±30 min jitter** (so the poll is not a reliable clock signal to
upstreams), a per-provider **failure budget** (3 consecutive auth failures ⇒ stop sending
that key, require manual re-enable), and **bounded concurrency** — reuse the existing 6
workers (`test-all.mjs:63`), chosen to avoid rate-limiting shared free tiers into false
failures.

### F9. A third-party metadata DB is already an unvalidated input

**Not hypothetical — already live.** `keysync.mjs:73` reads a **19.7 MB** file with 4,298
entries across 217 providers, `generatedAt: 2026-08-24`, whose `sources` names **models.dev**.
Its contents flow into `settings.json` today with no validation. It arrives via `npm i -g`,
and a global reinstall has already silently wiped a local patch once.

Risks in order of realism:
- **Wrong pricing ⇒ wrong tier label.** A `0` meaning "unknown" rather than "free" mislabels a paid model as free and — via the free-first sort — *promotes* it into the shipped top-3. Financial impact, no attacker required.
- **Wrong `contextTokens`** causes CC to over-fill context and get truncated or 400'd.
- **Injected ids/labels** — same class as F3, arriving through a package update.
- **Runtime-fetching LiteLLM's JSON** would add an unauthenticated network dependency in the credential-handling process and a TOFU trust decision every run.

```js
function admitCatalogEntry(e) {
  if (typeof e?.provider !== "string" || typeof e?.model !== "string") return null;
  const model = admitId(e.provider, e.model);
  if (!model) return null;
  const ctx = e.limits?.contextTokens;
  const contextTokens = Number.isInteger(ctx) && ctx > 0 && ctx <= 20_000_000 ? ctx : undefined;
  const nums = [e.pricing?.inputPerMillion, e.pricing?.outputPerMillion].map(Number).filter(Number.isFinite);
  const tier = !nums.length ? "unknown" : nums.every(v => v === 0) ? "free" : "paid";
  if (nums.some(v => v < 0 || v > 10_000)) return null;
  return { provider: e.provider, model, contextTokens, tier };
}

// Pin it: record a digest, require explicit acknowledgement when it moves.
const catalogDigest = crypto.createHash("sha256").update(fs.readFileSync(CATALOG_FILE)).digest("hex");
if (pinned.catalogDigest && pinned.catalogDigest !== catalogDigest && !has("--accept-catalog-change")) {
  throw new Error(`the bundled model catalog changed (likely an npm reinstall). Review, then re-run with --accept-catalog-change.`);
}
```
If a network-fetched DB is used: fetch it in a **separate process with no vault access**, pin
the digest, never fetch it in the same run that writes `settings.json`, and treat it as
advisory display metadata only — **never as the source of a model id**, which is routing input.

### F10. Provider error text and diagnostics captured into the cache or a crash artifact

```js
// test-all.mjs:44 — provider-controlled body text persisted verbatim
catch { why = body.slice(0, 60); }
```
Safe today (all three artifacts scanned, zero secret-shaped strings) but incidentally so: the
60-char truncation happens to cut before most echoed keys, and current traffic is chat, not
auth failures. Change the endpoint to `/v1/models` with 30 bad credentials and the population
shifts to exactly the messages that echo keys back.

```js
// GOOD — classify, never quote; scrub as a backstop
const KEYISH = /\b(sk-|gsk_|xai-|csk-|nvapi-|hf_|AIza|cpk_|pplx-)[A-Za-z0-9_\-]{8,}/g;
const scrub = (s) => String(s).replace(KEYISH, "[REDACTED]");
const classify = (status) =>
  status === 401 || status === 403 ? "auth_failed"
  : status === 402 ? "payment_required" : status === 404 ? "not_found"
  : status === 429 ? "rate_limited" : status >= 500 ? "upstream_error" : "other";
results.push({ provider, status, reason: classify(status) });   // no provider text at all
```

### F11. Unbounded cache and picker growth

`settings.json` is 7,982 bytes with 18 rows, parsed at every CC launch. Provider-declared
catalogs are far larger. Enforce hard caps **at ingest**: max 512 models per provider
response, max 256 KB per response body (streamed with a byte counter, not
`await res.text()`), max 128 chars per id, and keep `MAX_MODELS_PER_PROVIDER` at 3 for what
ships. **A provider exceeding a cap is a rejection, not a truncation.**

---

## LOW

### F12. Keep credentials out of process arguments — currently correct, easy to regress

`run.mjs:49-58` passes only **ids** on the PowerShell command line and returns values as JSON
on stdout — correct, avoiding `Win32_Process.CommandLine` exposure. Never
`curl -H "Authorization: Bearer $KEY"` via `execFileSync`, never interpolate a key into a
`-Command` string, never put a key in an env var a child inherits. Note `Import-ApiKeys`
(`ApiKeyVault.ps1:191-206`) does exactly that (`Set-Item -Path "Env:$($entry.envVarName)"`) —
fine interactively, wrong for a refresher.

### F13. Cache file placement and ACL

Reuse the `%LOCALAPPDATA%\uw-keysync` pattern with the explicit DACL rather than inventing a
location. The existing comment is worth honouring literally: *"Windows `mode` bits are a
no-op on NTFS, so set a real DACL."* Note a stray
`Usersosami.uwharnessscratchscale-picker-settings.json` in `~/.uw/keysync/` — evidence that
ad-hoc artifacts accumulate there.

---

## What should NOT be built as described

1. **Do not route catalogue fetches through the CCR gateway** (F2).
2. **Do not let a provider-declared model list reach `Providers[].models` without a reserved-name gate**, and promote the bare-id `console.warn` to a hard failure once lists are remote (F1).
3. **Do not schedule anything that writes `settings.json` or `config.sqlite`** (F8).
4. **Do not store raw `/v1/models` responses, response headers, or provider error strings** (F7, F10).
5. **Do not fetch a third-party pricing DB at runtime in the same process that holds credentials and writes `settings.json`** (F9).
6. **Do not lift `MAX_MODELS_PER_PROVIDER` when the source becomes remote** (F1, F11).

## Checklist

- [x] No hardcoded secrets — verified
- [ ] All inputs validated — **FAILS**: no charset/length/reserved-name validation on remote ids, labels, descriptions (F1, F3); no schema validation on the third-party catalog (F9)
- [ ] Injection prevention — **FAILS**: terminal escape injection (F3a) and routing-name injection (F1) unaddressed. JSON injection assessed and **not** a risk
- [ ] AuthN/AuthZ — **PARTIAL**: CCR RPC token is loopback-gated with constant-time compare, read fresh per call; but `providers.json` has no integrity control (F6)
- [x] Dependencies audited — keysync has **zero** third-party npm dependencies. The real dependency risk is the bundled 19.7 MB `models.json` (F9)
- [ ] Secrets not logged — **PARTIAL**: current code truncates errors and never logs key values; CCR redacts inbound auth headers but stores `request_logs.url` unredacted, and the body store has no retention (F2, F10)
- [ ] Security-relevant config integrity asserted — **FAILS**: post-write check is presence-only on 3 fields while `settings.json` carries 20 (F4)
- [x] TLS enforced — all 44 use `https://` today; **not enforced in code** (F6)

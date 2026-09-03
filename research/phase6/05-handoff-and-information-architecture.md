# Research: selection handoff + information architecture (2026-09-02)

The decisive report of the Phase 6 pass. Environment: CCR 3.0.22 (a heavily forked build),
config in `%APPDATA%\claude-code-router\config.sqlite` (`app_config.key='default'`, a single
JSON blob — **not** a JSON file on disk). Gateway live: PID 44540, edge `:3456`, core child
`:3457`, web UI `:3458`.

---

# Q1 — THE HANDOFF

## Router is restart-free — confirmed programmatically

`saveConfig` has exactly one restart branch:

```js
let a = i.configChanged || _E(r,o);
… s.gatewayManagedExternally ? (a ? s=await Ot.restart(o) : (await Ot.updateConfig(o), s=Ot.getStatus()))
                             : (a ? s=await Ot.start(o)   :  await Ot.updateConfig(o));
```

`_E`'s compared keys, enumerated from the dist:

```
gateway.{enabled,host,port,coreHost,corePort}, observability.{requestLogs,agentAnalysis,
requestLogBodyCapture,requestLogMaxBodyBytes}, proxy.{enabled,host,mode,port,systemProxy,
targets,upstream}, agent, mediaTools, Providers, plugins, providerPlugins, toolHub,
virtualModelProfiles

Router compared?             false
profile compared?            false
CUSTOM_ROUTER_PATH compared? false
```

Desugaring confirmed, from `YDe`:
```js
let r = S(e.target);
return [...t?[t]:[], ...r?[{key:"request.body.model", operation:"set", value:r}]:[]]
```
`model-prefix` desugars to `{left:"request.body.model", operator:"starts-with", right:pattern}`.

**The hot path is a genuine live swap, not a no-op:**
```js
async updateConfig(t){ …
  let r = await this.routeScriptRuntime.prepare(t.Router.rules);
  let n = new Qy(t,{scriptRuntime:this.routeScriptRuntime, scriptValidationErrors:r});
  this.config = t;
  this.plugin  = n;      // routing plugin replaced in-process
  … }
```
`Qy.routeRequest()` runs per request against `this.plugin`, so a repoint takes effect on the
**next request**.

## The trap: `virtualModelProfiles` IS in the restart set

It looks exactly like "the alias feature" (`match.exactAliases/prefixes/suffixes` →
`baseModel.fixedModel`), so it is the natural thing to reach for — and every repoint would
trigger a full gateway restart. **Use `Router`, never `virtualModelProfiles`.**

Restart is not cheap: `restart()` → `start()` → full `stop()` kills the core child process,
closes the `:3456` listener, tears down the route-script worker pool, the proxy, and **all
MCP servers**. CC holds several `ESTABLISHED` keep-alive sockets to `:3456` which a restart
resets. CC survives (separate process) but you eat seconds of downtime, MCP churn, and a
failed in-flight request.

## Better than `Router.rules`: two paths need no config write at all

Both re-read a plain file from disk **on every request**, so the TUI writes one JSON file
and touches CCR never.

**1. `CUSTOM_ROUTER_PATH`** — highest precedence, busts the require cache each request:
```js
let n = cUe(r);
delete ZM.cache[n];        // module cache deleted every request
let o = ZM(n);
let s = await i(t, this.config, {event:this.event});
return Qe(typeof s=="string" ? s : void 0);
```
Absolute paths and `~` allowed (the containment-to-config-dir check applies only to
*relative* paths); extension must be `.js`/`.cjs`/`.mjs`. Currently `""`, and **setting it
is itself a hot change** since it is absent from `_E`.

**2. A `script`-type `Router.rule` with `script.file`** — `qde()` `stat`s and re-reads the
file per execution; `ott()` resolves `~` and any absolute path with **no jail**. Runs in a
`node:vm` sandbox whose API includes `api.fs.readJson/readText/exists`, `api.env`,
`api.fetch`.

Either way the script stays static and reads `~/.llmkeys/slots.json`; the TUI writes only
that file.

## The one hard constraint

Both paths are bounded by the model registry:
```js
let c = this.compiled.modelRegistry.resolve(a);
let d = a && !c ? [{code:"custom-model-not-configured", …}] : [];
```
and in the script path an unresolvable model yields `script-model-not-configured` →
`matched:false`. **The target must already be in `Providers[].models`** — today 14 providers
/ 18 models.

**Escape hatch: `autoFetchModels`.** CCR's own poller (`lit = 600e3`) refreshes catalogs and
applies them via `onConfigChanged → Ot.updateConfig(t)` — **the hot path, bypassing `_E`
entirely**. So CCR already mutates `Providers[].models` at runtime without restarting; the
restart in `saveConfig` is a conservative blanket diff over the whole array, not a technical
necessity. No provider currently has it enabled, and there is no cap on `Providers[].models`
(just dedup via `Bu`). **One restart to add all providers with `autoFetchModels: true`, then
never restart again.**

## Two sub-questions, answered empirically

**Does `/model` persist a value that fights the alias? No.**
`/model` sets session state and optionally offers "save as default", writing the `model` key
in `settings.json`. The value it persists **is the alias** (`uw/slot-1`) — the same string
the picker row carries. CC's job is to keep sending a stable alias; the external tool changes
only what CCR maps it to. Persisting the alias as default is desirable.

**Does anything in CC cache the resolved model per session? No — and CC never even learns
the resolution.**

CC sends `body.model` on every request (1,019 requests, all `/v1/messages`). **CCR echoes
the *requested* model back in the response, not the resolved one:**

```
 41  req=anthropic/claude-sonnet-5      | resolved=anthropic/claude-opus-5                | RESPONSE=anthropic/claude-sonnet-5
 11  req=google/gemini-3.5-flash-lite   | resolved=provider-google-…/gemini-3.5-flash-lite| RESPONSE=google/gemini-3.5-flash-lite
  1  req=fanar/Fanar                    | resolved=anthropic/claude-opus-5                | RESPONSE=fanar/Fanar
```

The alias survives end-to-end and the real model never reaches CC. This is exactly what makes
slot indirection invisible and safe. (Minor wrinkle: 4 rows echoed the bare
`gemini-3.5-flash-lite` without the provider prefix — cosmetic only.)

Rewriting is **already proven working in the live deployment**: 37 requests went
`anthropic/claude-sonnet-5 ⇒ anthropic/claude-opus-5` and 7 went
`claude-opus-5 ⇒ …gemini-3.5-flash-lite`, with `Router.rules` still empty (those came from
profile/builtin routing).

## What CC supports

- **(a) `settings.json` `"model"` — next launch only, documented.** CC hot-reloads settings generally, but `model` is on the explicit exclusion list ("use `/model` to switch mid-session").
- **(b) `modelPicker.options` — reload timing undocumented.** Not on the documented start-only list either. Worth one 60-second experiment; don't build on it.
- **(c) Router indirection — works mid-session. Confirmed.**
- **(d) MCP / plugin / skill — no.** No documented mechanism lets a server set the caller's model. `PreModelSwitch` can *block*, `PostModelSwitch` can *observe*; neither initiates. Subagent `model:` frontmatter never touches the main thread. Agent SDK `setModel()` works only on SDK-spawned sessions; Remote Control is disabled by the custom `ANTHROPIC_BASE_URL`.
- **(e) `/model <name>` works mid-session and accepts arbitrary strings.** Because `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`, validation is skipped: behind a gateway or custom base URL, CC passes any string through unchecked. **This is what makes slot aliases work at all.**

## Ranking

| # | Mechanism | Mid-session | Invasive | Fragile |
|---|---|---|---|---|
| **1** | **`CUSTOM_ROUTER_PATH` / script-rule reading `slots.json`** | **Yes — next request** | One hot config write, ever | Med — undocumented internal, upgrade-sensitive |
| 2 | `Router.rules[].target` rewritten via RPC | Yes — hot `updateConfig` | RPC per change | Low-med |
| 3 | `/model <id>` typed by user | Yes | None | Low — needs the id, must be in `Providers` |
| 4 | `Providers[]` rewrite | Yes, after restart | Heavy — kills MCP servers | Med |
| 5 | `virtualModelProfiles` | **Restart** | Heavy | Med — *looks* correct, isn't |
| 6 | `settings.json` `"model"` | **No** | — | — |
| 7 | `modelPicker.options` | Probably not | — | — |
| 8 | MCP / plugin / hooks / env | **No** | — | — |

**Recommendation:** capability-typed slot aliases in the picker + `CUSTOM_ROUTER_PATH`
resolver reading `~/.llmkeys/slots.json`. Preferred over #2 because it avoids the SQLite
config and the RPC entirely.

## Two constraints to design around

1. **`behavesAs` is frozen per picker row.** All 14 third-party rows carry
   `"behavesAs": "claude-sonnet-4-6"`. A slot's capability contract cannot follow the
   repointing, so **slots must be typed by capability class** (`uw/big`, `uw/fast`,
   `uw/free`), not free-form.
2. **`env.ANTHROPIC_MODEL` shadows the `model` key.** The live `"model": "openrouter/hy3"`
   is **inert**, and so is its `modelSettings` entry — `env.ANTHROPIC_MODEL` is
   `anthropic/claude-opus-5[1m]`. `/model`'s "save as default" writes a key that never
   takes effect. Press `s` for session-only, or drop `ANTHROPIC_MODEL`.

## Fragility to plan for

Route scripts have a **circuit breaker: 3 failures in 60 s → open for 30 s**
(`Xet=3`, `Zet=6e4`, `ett=3e4`); any success resets. A malformed `slots.json` three times in
a minute silently disables the mapping for 30 seconds. Make the resolver defensive: wrap in
try/catch, return `undefined` on any error (falls through cleanly), and keep a static
`model-prefix` rule as a backstop. Script timeout defaults to 2000 ms (max 30000).
`CUSTOM_ROUTER_PATH` and these `Router` internals are **undocumented in the shipped
README** — pin the CCR version and re-verify `_E` after upgrades.

---

# Q3 — INFORMATION ARCHITECTURE: flat wins

## The usage data is the strongest argument

From `request-logs.sqlite`, 1,019 requests over ~11 hours:

- **26 distinct models** ever requested, across 21 providers
- **Top 5 models = 91.3% of all requests**
- Only path ever hit is `/v1/messages` — **zero `/v1/models` traffic**, so
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` produces no discovery calls through the gateway

A two-level menu taxes the 91% case — a fast switch among a handful of known models — with a
mandatory navigation step, to serve an exploration case that happens rarely.

## The corpus is smaller than the premise assumes

| Cut | Count |
|---|---|
| Catalog total | 4,298 |
| Offered by the 47 providers (distinct models) | 1,153 |
| …as `provider/model` rows | 1,918 (+23 uncovered providers ≈ 1,941) |
| **…with `toolCalling` (distinct models)** | **744** |
| …with `toolCalling`, as rows | 1,482 |
| …`toolCalling` + ≥200k context | 540 |

**Reconciliation with the 1,569 figure**: the gap is join strategy. Expanding
`m.providers[]` gives 1,918 rows / 24 covered providers; joining on primary `m.provider`
only gives 1,704 / 22; the 1,546 / 21 figure sits just below that (additional dedup). Agreement
within ~15%. The design-relevant number is post-filter: **744 distinct usable models.**

## Both sides, honestly

**For two levels:** a flat list of 1,500 opaque ids is intimidating cold. Hierarchy gives a
stable mental map, makes "what do I even have?" answerable, and lets provider-level metadata
(health, balance, key) be shown once rather than repeated per row. Genuine exploration is a
browse task, and browsing wants structure.

**For flat:** the hierarchy is **already encoded in the string**. Typing `alibaba` filters to
that provider in one keystroke — the drill-down affordance for free, with no traversal cost
and no dead end when you would rather filter *across* providers (`:free`, `glm`, `oss`). Two
levels force everyone through provider selection even when the provider is irrelevant to the
goal ("cheapest thing with 1M context") — a query the two-level shape actively obstructs.
And this user is not a cold user: they authored `providers.json` and use 21 providers regularly.

**Commit: flat.** A two-level menu's only real advantage — imposing structure — is redundant
when the key already contains the structure, while its cost (a mandatory step in the 91%
path, plus inability to query across providers) is paid on every use.

**Mitigation for exploration:** keep a separate `--providers` summary command for the rare
survey, and use the preview pane for per-provider detail. Neither should be the mandatory
first screen.

## Column redundancy — measurable

`personal.alibaba.paid` contains bucket, provider and tier verbatim. Key ids max 30 chars,
p50 22; 8 buckets, 3 tiers.

| Proposed column | Verdict |
|---|---|
| **key id** (`bucket.provider.tier`) | **Keep.** The disambiguator, and it does real work: `google` appears under **4** credential rows, `groq` 3, `zenmux`/`deepseek`/`openrouter` 2 each. Provider alone is not unique. |
| provider name | **Cut** — pure substring of the key |
| bucket / source | **Cut** — pure substring of the key |
| "has free models?" | **Weak.** `tier` is already in the key, and it describes the *credential*, not the models. Replace with a real per-model `FREE` flag from `pricing.offers[].per1MTokens.input === 0` (142 rows qualify). |
| model count | **Keep** — genuinely independent of the key |

Three of five columns are redundant; two earn their width.

**The missing column matters more than any listed: does this provider currently work.** From
`providers.json`: **8 of 47** have notes flagging breakage ("502 upstream_error on all tried
models", "key valid, chat backend down", "Retest before relying on it"), **16 of 47** set
`requiresBalance: true`, and **33 of 47** have not been re-verified since 2026-08-20.
Browsing into a provider that 502s is worse than not seeing it at all.

## Recommended layout

Width is a non-issue: the terminal is **209 columns**; the real data renders at **74**.

```
tokenharbor/deepseek-v4-flash:free        1M     FREE  -R  ok
aihubmix/coding-glm-5.1                 200k    $0.06  -R  ok
cloudflare/@cf/openai/gpt-oss-120b      131k    $0.35  --  stale
```

- **In the row:** `provider/model`, context, price, capability flags (V=vision, R=reasoning), health.
- **In the preview pane:** provider `notes`, `requiresBalance`, `updated`, docs URL, full capability matrix, all pricing offers, alternate providers for the same model. Master-detail — the dominant TUI pattern (fzf, skim, lazygit, k9s) — costs zero row width.
- **Default filters:** `toolCalling: true` on by default (drops 34% of pure noise), toggleable; `Tab` for free-only; a key to toggle "routable now" (in `Providers[]`, ~18) vs "whole catalog" (~1,500).
- Join `models.json` by **bare model name** (last path segment, strip `:free`) — measured **89% coverage (16/18)** on the currently configured set. Misses: `claude-fable-5-1`, `agnes-2.0-flash`.
- Output: a slot assignment written to `slots.json`.

**Keep a two-level shape only for the credential axis** (google×4, groq×3) — a genuinely
separate dimension the model string does not encode, and a rare deliberate action deserving
its own small command rather than a permanent level in the hot path.

---

## Net recommendation

1. **Handoff:** capability-typed slot aliases in `modelPicker.options` + `CUSTOM_ROUTER_PATH`
   resolver reading `~/.llmkeys/slots.json`. Hot, no restart, effective next request.
   `Router.rules` confirmed restart-free; avoid `virtualModelProfiles`, which is not.
2. **One-time setup:** enable `autoFetchModels: true` on providers (one restart) so the
   registry self-populates hot thereafter; set `CUSTOM_ROUTER_PATH` (no restart); relaunch CC
   once for the slot rows.
3. **IA:** one flat `provider/model` list, ~744 usable rows, master-detail preview, health
   column added, provider/bucket columns dropped.
4. **Fix independently:** `env.ANTHROPIC_MODEL` shadows the `model` key, making it and its
   `modelSettings` entry inert.

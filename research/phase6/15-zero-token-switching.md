# Research: zero-token, user-driven model switching inside Claude Code (2026-09-02)

Constraint that drove this pass: **the switch must cost zero Anthropic tokens and involve no
assistant turn.** That eliminates MCP elicitation, custom slash commands, and the
conversational design — all of which require the assistant to act.

All findings from `C:\Users\osami\.local\bin\claude.exe` (2.1.258, `strings -n 6`) and a
read-only copy of the CCR request log.

---

## 1. WORKS, best fit — gateway model discovery puts the WHOLE CATALOGUE into `/model`

Claude Code has a built-in mechanism that populates the `/model` picker from **your gateway's
own `/v1/models` endpoint**. The gate:

```js
function Tp(){
  if(!a.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) return !1;
  if(Oe()!=="firstParty") return !1;
  if(oi()) return !1;
  if(!a.ANTHROPIC_BASE_URL) return !1;
  return !0
}
function oi(){ if(a._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL) return !0; return GM() }
function GM(){ let e=process.env.ANTHROPIC_BASE_URL; if(!e) return !0; return NA(e) }
function NA(e){ try{ return ["api.anthropic.com"].includes(new URL(e).host) }catch{ return !1 } }
```

With `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`, `oi()` is **false**, so `!oi()` passes.
**The only thing missing is the env var.**

The fetch, once at startup (`urr(E)`, alongside `crr(E)`):
- `GET ${ANTHROPIC_BASE_URL}/v1/models?limit=1000`, headers `Authorization: Bearer …` / `x-api-key`, `anthropic-version: 2023-06-01`, **3000 ms timeout** (`Bte=3000`), `redirect:"error"`
- Response schema `{data:[{id, display_name?, description?}]}` (`.strip()`)
- **Hard filter:** `F = data.filter(ne => /(claude|anthropic)/i.test(ne.id))` — only ids containing "claude" or "anthropic" survive. Work around by naming aliases `anthropic/qwen3-max`; CCR maps the id back
- Cached to `<claude>/cache/gateway-models.json` as `{baseUrl, fetchedAt, models}`; on read, `cached.baseUrl` must equal `ANTHROPIC_BASE_URL`

Rows (`bme()`): `{value:id, label: display_name||id, description: truncate(description,100) || "From gateway"}` — `Hte=100` is the description cap. **No count cap anywhere.**

**Why this is live rather than dead code:** in `dXr`, gateway rows are appended only when the
served Anthropic catalogue is absent (`r===null`). `wC()` returns null unless
`pf() = Oe()==="firstParty" && oi()`. Because `oi()` is **false** behind CCR, `pf()` is false,
`wC()` is null, and gateway rows **are** included, on top of the static built-in lineup.

**Cost: zero tokens, user-driven, mid-conversation, no second terminal, full catalogue.** It
also solves labelling: `display_name` is the label, `description` gives 100 chars for
context/price/free-tier.

Caveats:
- Fetched **once at process start** (memoised in `gatewayModelsByCachePath`) — the list is fixed for the session. Fine: the catalogue does not change mid-session.
- `Oe()==="firstParty"` must hold (true unless Bedrock/Vertex/Mantle env vars are set).
- The env var is **undocumented** and could change across auto-updates.
- **Gateway rows are added BEFORE `fXr`, so `replaceBuiltInOptions: true` ERASES them.** The two mechanisms are mutually cancelling — and both are currently set in live settings, which is why gateway discovery has had no effect.

## 2. WORKS — a `UserPromptSubmit` hook that swallows the prompt (genuinely zero-token)

Confirmed rigorously. `runUserPromptSubmitHooks` (`$Re`, line 434185/434186):

```js
if(T.blockingError){ return {blocked: o8(oRe(TJ(T.blockingError), e, T.suppressOriginalPrompt)), …} }
if(T.preventContinuation){ … r.shouldQuery=!1, r.resultText=j, r.allowedTools=void 0, … }
```
```js
var o8=(e)=>({messages:[Ot(e,"warning",void 0,t8)], shouldQuery:!1, resultText:e});
```

**`shouldQuery:false` on both block paths → the turn ends before any Anthropic request.**
`ug()` maps the hook JSON: `decision:"block"` **or** `continue:false` both block.

- **Display to the user: YES.** The block text is pushed as `Ot(…,"warning",…)`, a local warning message. `systemMessage` is documented in-binary as *"Warning message shown to the user"*. `hookSpecificOutput.suppressOriginalPrompt:true` stops the `"\n\nOriginal prompt: …"` suffix (`oRe`).
- **Caps:** `{reason:2000, stopReason:2000, systemMessage:4000, additionalContext:8000}` chars and `{reason:20, stopReason:20, systemMessage:20, additionalContext:200}` lines.
- **Bonus free surfaces:** `terminalSequence` emits OSC 0/1/2 (terminal title) and 9/99/777 (desktop notification); `hookSpecificOutput.sessionTitle` sets the session title. Both usable as a persistent "current model" indicator, at zero cost.
- **Interactive? No.** Hooks are one-shot text. But a two-round picker works: `>>models qwen` → hook prints ≤20 numbered lines → `>>7`. **Both rounds blocked, both free.**
- **Timing:** `Hgn = {PreToolUse:15, …, UserPromptSubmit:30, UserPromptExpansion:30, Stop:120, …}` seconds; synchronous and blocking on submit. A local file rewrite is milliseconds.
- `UserPromptExpansion` is a second, earlier event with identical block semantics.
- Hooks also run for slash commands (`processSlashCommand` receives `executeUserPromptSubmitHooks`).

Residual uncertainty: a blocked turn leaves one local warning + one `isMeta:true` message in
the transcript. These are UI-only, so ongoing cost should be nil, but the API serialiser was
not traced to prove it.

**Full 2.1.258 hook event list:** `PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch,
Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop,
StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch,
PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated,
TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay`.

## 3. WORKS PARTIALLY — `/model` navigation and a keybinding shortcut

- **No cap on total `modelPicker.options`.** No `slice`, no length check anywhere. Honored from managed / `--settings`/SDK / user settings only; highest-precedence source wins outright, no merging.
- **Viewport hard-capped at 10, and a taller terminal does not help:**
  `xo = Math.max(2, Math.min(10, Math.floor((rows - 14 - Wo - Ko - nn)/2)))`, then
  `Vn = Math.min(xo, vn.length)` passed as `visibleOptionCount`. Each row costs 2 lines.
- **Paging exists and is bound by default** in the `Select` context: `pageup→select:pageUp`, `pagedown→select:pageDown`, `home→select:first`, `end→select:last`. In `DOn`: `"select:pageDown":()=>$e(E)` where `E` is `visibleCount` — **PageDown moves exactly 10 rows.** 1,569 rows ≈ **157 presses**. `home`/`end` jump instantly.
- **No numeric jump and no type-ahead in `/model`.** `DOn` has an `onRowKeyDown` hook, but `kZ` does not pass one.
- **Search is permanently dead.** Across the whole binary there are exactly **two** `canEnter:` occurrences — the parameter inside `gSe` and the single call site `gSe({canEnter:!1, …})`. It is a **literal, not a flag**; no env var, setting, or policy flips it.
- **Keybindings are user-configurable** in `~/.claude/keybindings.json`, and an action may be `command:<name>`, described as *"Executes the slash command as if typed"* (must be in the `Chat` context). Binding a key to `command:model` opens the picker with zero tokens. Does not solve catalogue size.
- **Ordering advice** given 10 visible rows / 100-char descriptions / ~60%-width label truncation: sort by provider, prefix the label with a short provider tag so `home`/`end` plus 10-row pages land near provider boundaries predictably, and pin favourites at the very top (index 0 is one `home` away). **Realistically serve a curated few-hundred-row list rather than all 1,569.**

## 4. Per-session routing — SOLVED, natively

Claude Code sends a session header on every request:

```js
var xFe="X-Claude-Code-Session-Id";
let W={ "x-app":St()?"cli-bg":"cli", "User-Agent":iH(), [xFe]:Q(), …,
        ...B?.agentId&&{"x-claude-code-agent-id":vAn(B.agentId)},
        ...B?.parentAgentId&&{"x-claude-code-parent-agent-id":vAn(B.parentAgentId)} };
```

Confirmed live in the CCR log for a real `POST /v1/messages`:
```
x-claude-code-session-id:        76ac34d9-c9e8-43f4-8cfa-18bf9783c39c
x-claude-code-agent-id:          ccr-logs@session-f49cde2f
x-claude-code-parent-agent-id:   a132fcb025b4081ae
x-app:                           cli
user-agent:                      claude-cli/2.1.257 (external, cli)
x-client-request-id:             c549a1b3-…
x-stainless-{arch,lang,os,package-version,retry-count,runtime,runtime-version,timeout}
```

The session id matches the session's transcript directory, so it is the real CC session UUID.
A CCR custom router can key on `req.headers['x-claude-code-session-id']` for per-session
mappings, and on `x-claude-code-agent-id` to route subagents separately from the main thread.
**These four are in a protected set (`v7`) that `ANTHROPIC_CUSTOM_HEADERS` cannot override.**

`metadata.user_id` is **not** in the body — bodies start `{"model":…,"messages":…}`. It appears
only if injected via `CLAUDE_CODE_EXTRA_BODY`. The header is the right discriminator.

**Note:** with gateway discovery (mechanism 1), per-session routing is automatic — each session
sends its own chosen `body.model` string, so no shared alias is being repointed at all.

## FAILS — plainly

- **MCP elicitation.** Not for rendering reasons — the picker is actually good: scroll window sized from terminal height, `↑ N more above` / `↓ N more below`, radio rows, **2-second-buffer type-ahead prefix search** over labels (`_n(zn,Yn,cb)`), `right` to expand, `space` to select, rich labels via `enumNames` or `oneOf:[{const,title}]`, and **no size cap** in the Zod schema (contrast `CompleteResultSchema`, which has `.max(100)`). It fails **only** on the token constraint: an MCP tool is invoked *by the assistant*, so every switch costs a turn. `ElicitRequestURLParamsSchema` (`{mode:"url", message, elicitationId, url}`) can hand the user a clickable URL to a local web UI, resolved later by `notifications/elicitation/complete` — but still needs an assistant turn to fire.
- **`PreModelSwitch` cannot redirect.** In-binary: *"Same contract as PreToolUse: allow proceeds (skipping the interactive cache-miss confirm), deny cancels the switch, ask asks the user to confirm (a headless session refuses instead)"*. Only `permissionDecision` + `permissionDecisionReason` — **no model field**. `PostModelSwitch` offers only `additionalContext`, which *"Reaches the model with the next request the new model serves"* — i.e. costs tokens.
- **`Elicitation` / `ElicitationResult` hooks** can auto-accept/decline an elicitation but cannot originate one or render a list.
- **User/plugin slash commands** remain `type:"prompt"` — they inject a prompt and cost a turn. `local-jsx` built-ins are not extensible.
- **`ANTHROPIC_CUSTOM_MODEL_OPTION`** adds exactly **one** row. Not a catalogue.
- **No IPC/control socket on an interactive TUI session.** The control-request path (`mcp_call`, `request_user_dialog`, `set_permission_mode`, …) belongs to the SDK stdio transport; there is **no `set_model` subtype** and no listener an external process can drive on a normal terminal session.

## Recommended combination

1. **Gateway model discovery** for browsing and switching — `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` plus CCR serving `/v1/models` with `claude`/`anthropic`-prefixed ids. **Requires dropping `replaceBuiltInOptions: true`**, which currently cancels it.
2. **The `>>` hook** as the fast path for frequently-used models — blocks, zero tokens, with `systemMessage` for confirmation and `sessionTitle`/`terminalSequence` as a persistent indicator.
3. **A `command:model` keybinding** in `keybindings.json` for one-keystroke picker access.
4. **Per-session routing** on `x-claude-code-session-id`.

Separately and independently: **`/model <name>` accepts arbitrary strings** behind a custom
base URL (`Hkt = {type:"local", name:"model", argumentHint:"<model>", supportsNonInteractive:true}`),
so any model already in `Providers[].models` can be switched to by typing its id — zero tokens,
no picker involved.

---

## REVISION (same session, verified independently) — `metadata.user_id`

**Correction: the earlier claim that `metadata.user_id` is "not in the body" was WRONG.** It
was based on reading only the first 1200 bytes of one body file; metadata sits at the **end**.

The real construction:
```js
let k = { ...d&&{ti:d},
  device_id: yH(),
  account_uuid: (Le(a.CLAUDE_CODE_REMOTE)&&a.CLAUDE_CODE_ACCOUNT_UUID)||$M()?.accountUuid||Dn()?.accountUuid||"",
  session_id: Q(),
  ...p&&{parent_session_id:p}, ...y&&{tk:y} };
…
return { user_id: b(T) };            // b() = JSON.stringify
```
So the wire value is
`"user_id":"{\"device_id\":\"<64 hex>\",\"account_uuid\":\"\",\"session_id\":\"<uuid>\"}"`.

`session_id: Q()` is the **same `Q()`** that fills `X-Claude-Code-Session-Id`, which explains
why the two were byte-identical in 924/924 rows.

**The conclusion is unchanged — key on the header** — and now for three concrete reasons:
- `device_id` is machine-stable (one value across all 64 sessions), so useless as a discriminator
- `account_uuid` is empty on this install (auth goes via CCR, not a Claude account)
- metadata sits at the **end of the body**, and CCR truncates large bodies
  (`request_body_truncated=1`), so `json_extract` on `request_body_text` fails

### Header evidence is now conclusive rather than single-row

`x-claude-code-session-id` is a lowercase UUIDv4, **stable across 946 requests over ~12 h**
under one value, **64 distinct values** in the log, client-sent (present on **1044/1044**
`claude-cli` requests, 0/2 curl, 0/41 node), and **proven safe under concurrency** — two
sessions interleaved second-by-second (`04:42:53` one, `04:42:55` the other, `04:42:57` both).

### Additional corrections

- **Headers previously missed:** `accept-language`, `sec-fetch-mode`.
- **Do NOT key on** `x-ccr-route-reason`, `x-ccr-route-source`, `x-ccr-routed-model`, `x-auth-api-key-id`, `x-auth-sub` — CCR-injected, not client-sent.
- **Subagent discrimination is richer than first reported.** `user-agent` separates thread kinds: main thread sends `claude-cli/2.1.258 (external, cli)`, subagents send `(external, sdk-cli)`. `x-claude-code-agent-id` appears **only** on subagent traffic, in two shapes — opaque `a`+16 hex, or `<teammate>@<team>`. `x-claude-code-parent-agent-id` (opaque form) gives the parent→child tree and is empty at top level. `x-client-request-id` is unique **per request** (284 distinct / 284 rows) — **not** a session key.
- **Model alias forms: the router must handle BOTH.** Bare (`claude-opus-5`, CC's own selection) and prefixed (`anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`, `anthropic/claude-fable-5-1`) both appear depending on session config; CCR rewrites into `resolved_model`.

```js
const sessionId = req.headers['x-claude-code-session-id'];
const agentId   = req.headers['x-claude-code-agent-id'];
const isSub     = /sdk-cli\)$/.test(req.headers['user-agent'] || '');
```

### One extra lever surfaced

**`CLAUDE_CODE_EXTRA_METADATA`** (a JSON object env var) merges custom keys into `user_id`,
alongside **`CLAUDE_CODE_EXTRA_BODY`** which merges arbitrary JSON into the request body. Both
are read at process start and both are subject to a size cap (oversized extras are dropped,
falling back to the base keys). Usable to stamp a per-session tag at launch — though the
header already does this for free.

## Artifacts

A reusable 45 MB strings dump of `claude.exe` remains at
`~/.uw/research/phase6/_tmp/cc_strings.txt` with a helper `ctx.py`, for follow-up mining.
Regenerable with `strings -n 6 claude.exe`. Nothing under `%APPDATA%\claude-code-router\` or
the Claude install was modified; the temporary copy of `request-logs.sqlite` was deleted.

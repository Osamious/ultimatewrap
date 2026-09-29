# Research: would UW have hit the compaction and capability limits on DeepSeek Harness? (2026-09-06)

Counterfactual asked after reports 17 and 18 landed: are those two limitations **inherent to
wrapping any agent harness**, or **specific to Claude Code**? Answered by reading a concrete
alternative at source.

Method: cloned `github.com/deepseek-ai/deepseek-harness` (HEAD `d347e703`, committed
2026-09-04) and read it. Every claim below cites a file and line in that checkout unless
labeled inferred. Nothing was executed.

The two limitations under test:

- **Limitation A** (report 17) — the compaction trigger cannot track a model switch live. The
  window belief comes from a borrowed profile; the only exact channel is one process-global env
  var; that var cannot be rewritten in a running process without injection.
- **Limitation B** (report 18) — no per-model capability declaration for third-party models.
  Eight client-side predicates resolve from the same borrowed-profile mechanism.

---

## 1. The artifact is real

| | |
|---|---|
| Repository | `github.com/deepseek-ai/deepseek-harness`, default branch `master` |
| License | MIT, "Copyright (c) 2026 DeepSeek" (`LICENSE:1-3`) |
| Version | `0.1.3-alpha.1` (`package.json:3`) |
| Language | TypeScript ESM, Node `^22.19.0 \|\| >=24.0.0` |
| Structure | pnpm monorepo, 9,080 files, ~102 MB, 46 package groups under `packages/` |
| Distribution | `npx @deepseek-ai/dsh web`; CLI binary `dsh` |
| Maintenance | HEAD 2 days old; 863 `*.spec.ts`; CI on ubuntu, macos, and a self-hosted Windows runner |
| Stability | "developer preview… **THERE WILL BE COMPATIBILITY-BREAKING CHANGES**" (`README.md:11-13`) |
| Security | "has not undergone a security audit and must not be treated as secure or production-ready" (`SAFETY.md:5-7`) |

Architecture: everything-is-a-plugin over **Cordis** (`@deepseek-ai/cordis` v4.0.2, MIT, a
vendored copy of upstream `cordiverse/cordis`). Configuration is a patch-overlay model, not a
single file: `cordis.yml` is **generated** by dsh (`apps/cli/src/profile-boot.ts:121`), while
the file a user edits is `$DSH_HOME/profiles/<name>/cordis.patch.yml` plus a home-level
`$DSH_HOME/cordis.patch.yml` (`profile-boot.ts:71`). Format is a list of
`- insert: [{id, name, config, disabled}]` rows; profiles compose ordered bundle layers plus
the user's patch, last-write-wins per row id.

Report 16's row on this harness is confirmed accurate, including its context-window constants
(262,144 BYOK / 1,000,000 native).

**Scope caveat carried through the whole report**: the generic multi-provider adapter
`packages/llm/llm-pi-ai` wraps a third-party package, `@earendil-works/pi-ai` v0.84.2.
`node_modules` was not installed, so **pi-ai's internals were not read** — its bundled catalog,
its `anthropic-messages` implementation, and its cache-marker placement are all outside the
evidence base. dsh's wrapper around it was read in full.

---

## 2. Limitation A does not exist there

The auto-compaction listener registers on `agent/pre-step` — before every step of every turn
(`packages/compaction/compaction-basic/src/index.ts:148-166`). The trigger body:

```ts
const target = routedTarget(agent.session)                                          // :264
const policy = resolveTargetPolicy(this.config, target)                             // :266
const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context  // :294
if (context === undefined) {
  throw new TargetPressureConfigError(targetKey,
    `compaction-basic: no context capacity for ${targetKey}; configure contextWindow on that adapter model`)
}
const spec = resolveCompactSpec(policy, context.contextWindow)                       // :304
if (measurement.totalTokens < spec.thresholdTokens) return null                      // :305
```

And `routedTarget` reads the model of the **latest request**, not a session-start snapshot:

```ts
/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session: Session) {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}
```

The threshold ratio is itself per-model overridable — `resolveTargetPolicy`
(`config.ts:105-125`) looks up an exact `{provider, model}` match in a user-supplied
`modelPolicies[]` table and merges field-by-field over defaults (`DEFAULT_THRESHOLD_RATIO = 0.8`,
`DEFAULT_RETAIN_RATIO = 0.16`). Duplicate targets fail **at plugin load**, not at runtime
(`config.ts:204-208`).

Window resolution is a four-layer ladder in the pi-ai adapter (`catalog.ts:862-869`): the user's
per-model declaration, then pi-ai's bundled catalog entry, then a **per-route configurable**
`defaultContextWindow` (262,144), with live `/v1/models` discovery capturing the value where an
endpoint discloses it. Changes take effect live — the settings file is chokidar-watched and the
adapter re-reads its snapshot on every resolve, reusing cache only on identity equality
(`adapter.ts:232-239`).

**Why A cannot arise here.** A has three ingredients in Claude Code: the belief comes from a
borrowed profile; the only exact channel is a process-global env var; that var cannot be
rewritten live. dsh has none. The window is a per-`(provider, model)` adapter answer, `await`ed
fresh at every pre-step, and the only global in the path — the compaction plugin's own config —
is itself keyed by exact provider/model. A mid-session switch changes capacity *and* policy on
the next step, with no signal, no keystroke, no correction command.

Two secondary confirmations of report 16: reactive recovery exists alongside the proactive
trigger (an `agent/request-error` listener on `CONTEXT_WINDOW_EXCEEDED_CODE` forces a
`'context-overflow'` compaction and replays), and dsh genuinely **does not parse the limit out
of the provider's error text** — `packages/llm/llm/src/error.ts` contains zero `match(`/`exec(`
calls, pure boolean classification.

The unknown-model failure mode is honest rather than wrong: if an adapter declines to declare a
window, `compactIfNeeded` throws, the handler warns once per target key, and the turn continues.
Auto-compaction goes inert for that route rather than firing at a fabricated number.

---

## 3. Limitation B does not exist there either

Three capability axes on the core type (`packages/llm/llm/src/types.ts:339-347`):

```ts
export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: LlmModelContext          // window
  defaultMaxTokens?: number
  reasoning?: LlmModelReasoningInfo  // efforts + defaultEffort
}
```

A model declares which effort levels it actually offers, in adapter-preferred order, with a
default. In config that is a plain per-model map: `reasoningEfforts: { off:, high: high, max: ultra }`
— key is the selectable level, value is the wire spelling.

**The wire-compat profile is the direct analogue of Claude Code's eight gated predicates** —
`PiAiCompatProfile`, 22 fields, settable on the route **or per model, field by field**
(`catalog.ts:340-406`):

| Claude Code predicate (report 18 §1) | dsh compat field |
|---|---|
| `temperature` | `supportsTemperature` |
| `adaptive_thinking` | `forceAdaptiveThinking` |
| `thinking` | `requiresThinkingAsText`, `thinkingFormat`, `supportsThinkingTokenBudget`, `allowEmptySignature` |
| `effort` / `max_effort` / `xhigh_effort` | `supportsReasoningEffort` + per-model `reasoningEfforts` map |

Plus caching and tool-schema switches Claude Code has no user-facing equivalent for
(`cacheControlFormat`, `supportsLongCacheRetention`, `supportsCacheControlOnTools`,
`supportsStrictTools`, `supportsEagerToolInputStreaming`).

**DeepSeek's own comment states the exact diagnosis this project reached independently:**

> "pi-ai decides each of these from the provider id and baseURL when no layer sets it, and **a
> private gateway's URL says nothing: for an endpoint it does not recognize the detection answers
> as though it were OpenAI itself, which is wrong for most OpenAI-compatible gateways.** So every
> field here is one a deployment must be able to state **because nothing can infer it**."
> (`catalog.ts:328-331`)

There is **no borrowing mechanism anywhere in dsh**. An unrecognized model is an error:

```ts
const resolved = snapshot.models.getModel(provider, model)
if (resolved === undefined) {
  throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
}
```

**Why B cannot arise here.** `behavesAs` exists because Claude Code has a *privileged baked
catalog of Anthropic models* which is the only vocabulary it can describe a model in — so an
unknown id must be mapped into that vocabulary or fall to blanket defaults. dsh has no
privileged model family; every route, DeepSeek's own included, is described by a configured
adapter through one interface. **There is nothing to borrow from, so the concept never had to be
invented.**

Worth stating precisely: this is not "no capability concept, therefore no wrong assumptions."
dsh has real capabilities with genuine adaptation — an image prompt against a model whose
declared modalities exclude `image` is refused before dispatch
(`packages/api/session-controller/src/commands.ts:322-331`). What it lacks is *inference*.

---

## 4. What UW would have hit instead

### Blocking

**No terminal agent.** `apps/` contains exactly `cli` and `web`. The CLI is a profile/boot
launcher whose only subcommands are `web` and `plugin` (`apps/cli/src/args.ts:156,171`). No
`ink` or `blessed` dependency exists anywhere in the repo. The primary interface is a browser UI
at `127.0.0.1:3080`; the other drivers are ACP for editors, and the SDK.

This is the largest problem. UW is terminal-native throughout — `uwpick-run.ps1` reading the
console input buffer, the statusline shim, the HUD, the `/model` handoff, and **report 17's
entire §4 solution space** (console input records, terminal titles, `AttachConsole`) all
presuppose a terminal-hosted agent. Against a browser UI that layer has no counterpart; it would
be deleted, not ported.

**No subscription concept.** UW's whole reason to wrap Claude Code is proxying a real Anthropic
subscription. dsh models API keys and generic OAuth grants and nothing else. `QUOTA_EXCEEDED_CODE`
exists for error classification only — no rate-limit window modeling, no
`anthropic-ratelimit-unified-*` surface, no plan display. **Report 14's entire subject has no
host to attach to.**

Precise about the shape of this loss: report 18 §6.3 shows Claude Code *already* withdraws the
subscription surface on any non-`firstParty` shape, so this is not "dsh loses what Claude Code
guarantees." It is that dsh never had it, **and is not the client that subscription is sold
for.** A dsh-based passthrough would be a non-Anthropic tool presenting to a first-party
endpoint — a materially different posture than routing Anthropic's own CLI. Whether that is
acceptable use is a policy question, not a technical one, and it likely dominates the technical
analysis entirely.

**No `apiKeyHelper`.** No built-in equivalent to Claude Code's rotating-token helper command. A
workable substitute exists — the managed credentials file is chokidar-watched and external edits
hot-publish — but note the trap: **the inherited process environment wins** over the managed
file, so an `ANTHROPIC_API_KEY` in the launch env would silently shadow every rotation.

### Would have been easier

**Anthropic-shaped passthrough with an arbitrary base URL.** `anthropic-messages` is a
first-class selectable wire protocol for a hand-declared route
(`packages/llm/llm-pi-ai/src/provider.ts:47-51`), alongside `openai-completions` and
`openai-responses`. Arbitrary per-route request headers are settable, only `user-agent` reserved
— so `Authorization: Bearer …` is expressible. Compare report 18 §6.2-6.3, where reaching an
exact-declaration channel in Claude Code meant adopting the Foundry deployment shape and paying
the whole subscription surface for it.

**Zero-token mid-session switching — native.** `selectModel` resolves the call config, installs
it via `selectForNextRequest`, and persists it as default; session-local, touches no history
(`commands.ts:124-160`). **Report 15's subject is a solved problem here.**

**~45 providers** — config-only for anything speaking one of the three supported wire formats. A
genuinely new format needs a new adapter package. Note the corollary: CCR's translation layer
would become unnecessary for most providers, **which also means report 18 §7's finding
evaporates** — CCR currently strips `thinking`/`effort` for 44 providers incidentally and for
free; dsh has no such accidental sanitizer. Its equivalent is the explicit compat profile:
better, but it must actually be filled in.

### Mixed

- **MCP**: client only, no server — but both **stdio and Streamable HTTP/SSE** transports, over
  the official `@modelcontextprotocol/sdk` with no custom wire protocol
  (`packages/mcp/mcp-client/src/index.ts:50-98`, `transport.ts:9-11,31-49`). Each server is one
  Cordis plugin row with a unique `serverName`.
- **Hooks**: dsh ships a bridge for **unmodified Claude Code command hooks** supporting
  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`.
  `updatedInput` is logged and warned but not honored. **No `PreCompact`.** See §5 for the
  hook-injection finding, which matters more than the coverage list.
- **Skills and tools are a larger surface than Claude Code's.** A provider-agnostic skills
  registry (`packages/skill/skill/`), a filesystem provider, and a model-facing `skill` tool
  with summary-then-invoke. Beyond the file/shell/terminal set: `todo_write`, `subagent` +
  `send_message`/`interrupt_agent`, `job_output`/`job_list`/`job_kill`,
  `get_goal`/`create_goal`/`update_goal`, five `session_*` search/trace tools, `lsp`,
  `ask_user_question`, `ralph`. Skills, commands, and MCP clients are all agent-scoped
  registries on one `dsh-scope` layer primitive. Slash commands are a real durable registry
  with paired `command/run`/`command/done` session events.
- **Prompt caching**: dsh itself places no cache markers; `cache_control` appears only as compat
  switches in the pi-ai wrapper, and pi-ai was not read. One deliberate cache-aware design note:
  the compaction summarizer reuses the conversation's own system prompt, tools, and messages as
  its prefix "so the provider's KV cache is not invalidated" (`compaction-basic/src/index.ts:228-231`).
- **No cost accounting** for pi-ai routes, stated outright: `NO_COST`, with the comment *"the
  absence of a fact, not a configurable rate"* (`catalog.ts:32-37`). Report 14's billing display
  would be built from scratch.
- **~1,500 rows**: structurally supported, but `buildModelCatalog` awaits `resolveModelInfo` for
  every model of every provider on each build (`catalog.ts:16-45`). For pi-ai those resolve
  in-memory, so O(N) cheap work rather than N network calls — untested at this scale, and no
  picker virtualization was verified.
- **Maturity**: alpha, no security audit, breaking changes promised. Report 10 exists because
  Claude Code is a moving target read from a minified binary; dsh trades that for a moving target
  with a public changelog and 863 tests. Better shape, not obviously less churn at
  `0.1.3-alpha.1`.
- **Curiosity**: dsh can run Claude Code itself as a one-shot subagent via the official Agent
  SDK (`packages/subagent/subagent-claude-code/`), alongside `subagent-codex` and `subagent-acp`.

---

## 5. Verdict

**Limitations A and B are Claude Code-specific, not inherent to wrapping an agent harness.** dsh
is a source-level existence proof for both.

**Specific by design, but in a narrower sense than it first appears.** Neither is a bug Anthropic
overlooked. Both fall out of one architectural fact: Claude Code has a privileged baked catalog
of Anthropic models that is the only vocabulary in which it can describe a model. Given that,
`behavesAs` is the *correct* design — for a first-party client whose job is running Anthropic
models well, mapping an unknown id onto a known profile beats refusing. The env-var channel is a
deployment-shape escape hatch for Bedrock/Vertex/Foundry operators, and those are process-global
because a deployment shape *is* a process-level fact. It is not a per-model table because in
Anthropic's model of the world nobody switches between 1,500 third-party models mid-session.

These are not constraints imposed to stop UW. They are the shape of a tool built for one model
family, hit by a use case orthogonal to its design. Anthropic could change them — report 17 §1
found the env resolver is already a live property getter, so a per-model table would be a small
change on existing machinery — but there is no product reason to.

Report 17 §3.3 is different in kind and **is** deliberate: Claude Code's named defense against a
plugin submitting a slash command on the user's behalf is a real security decision and will not
move.

**And it is not a Claude Code peculiarity — it is convergent design.** dsh independently has the
same property. The only injection channels available to a hook there are `agent.inject()` (adds
a `UserMessage`) and `agent.steer()` (forces another step with model-facing text) — both plain
conversational content. There is **no code path from `hook-protocol` / `hooks-claude-code` /
`hooks-codex` into the `dsh-commands` registry** (`hooks-claude-code/src/index.ts:206-215,270-277`),
even though dsh has a real durable slash-command registry for hooks to reach if the seam existed.

Two independent harnesses, same constraint, arrived at separately. That closes the question
report 17 left slightly open — whether Claude Code's hook restriction was a deliberate security
choice or an omission. It is deliberate, and it is the norm. The difference is only that on dsh
it **costs nothing**, because compaction tracks the switch automatically and there is no
correction command that a hook would need to fire.

**Would dsh have been a better starting point? No — worse, decisively, for reasons unrelated to
A or B.**

It would have solved the problems behind reports 16, 17, 18 and 15's zero-token switching, and
removed the need for CCR's translation layer for most providers. Real work erased. But it would
have destroyed the premise: no subscription concept, no terminal interface, and it is not the
client the subscription is sold for. Reports 14 and 15's subject matter would be rebuilt from
nothing.

And correctly, **A and B are not the expensive part of UW.** Report 17 landed a verified,
zero-risk fix for A. Report 18 landed a bucketing approach for B whose most severe consequence
turns out to be already neutralized by CCR for 44 of 45 providers. Trading a working subscription
passthrough and an entire terminal UX to eliminate one keystroke per switch and some local UI
imprecision is a bad trade.

---

## 6. What transfers anyway

dsh is worth reading as a design reference even though it is the wrong base. Three things apply
to UW's own catalogue and picker regardless of Claude Code's ceiling:

1. **The unknown/negative tri-state.** *"Accepted request modalities; absent means unknown, while
   an explicit omission is negative capability"* (`types.ts:308-309`) — exactly the fix report 18
   §9.2 identifies for `menu/catalog.mjs:178`'s `!!` coercion. dsh comments on it twice and acts
   on it in preflight, treating it as load-bearing rather than pedantic.
2. **Make the guess visible and editable.** *"The fallback is a guess by construction, which is
   why it is a configurable route field rather than a constant buried here"* (`catalog.ts:862-866`)
   — a better resolution of report 16 §2's guess-versus-refuse disagreement than either camp:
   guess, but expose the guess at the level where the user knows the answer.
3. **Per-target policy keyed on exact `{provider, model}`, with duplicate detection at load
   time** (`compaction-basic/src/config.ts:105-125, 204-208`). This is the shape UW's own
   bucketing table should take — validate at build, not at use.

---

## Not verified

- **`@earendil-works/pi-ai` v0.84.2 internals were not read** — `node_modules` was not installed.
  Its bundled catalog, `anthropic-messages` implementation, `cache_control` placement, and
  baseURL-based capability detection are outside the evidence. The prompt-caching answer in §4 is
  therefore partly documentation-derived.
- **Nothing was executed.** No `dsh` launched, no request observed, no compaction triggered.
- The ~1,500-row and ~45-provider scaling claims are structural inferences, not measurements.
- The web frontend was not read beyond one file; the "browser UI is primary" claim rests on
  `apps/cli/src/args.ts`, `README.md`, and the absence of any TUI dependency.
- Hook *coverage* may be incomplete — the Claude-Code-bridge list was enumerated from
  `hooks-claude-code/src/config.ts` only, and dsh's *native* extension points
  (`ctx.on('agent/pre-step')` and family) are a larger surface, sampled rather than enumerated.
  The hook-*injection* finding in §5 is a separate, positively-traced result: the absence of a
  path into `dsh-commands` was followed through three hook packages.
- The exact name of `tool-web`'s tool was not confirmed.
- The "no borrowing anywhere" claim rests on both shipped adapters plus the core runtime. A
  third-party adapter plugin could implement borrowing; nothing in the seam prevents it.
- **Whether Anthropic would treat a dsh-based subscription passthrough as acceptable use was not
  researched, and likely dominates the technical analysis in §4.**
- Report 16's claim about an architecture note recording DeepSeek's rejection of error-text
  parsing was not located; the *behavior* was confirmed (no capture groups in `error.ts`), the
  document was not.

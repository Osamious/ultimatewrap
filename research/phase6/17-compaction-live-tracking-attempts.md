# Research: live per-model compaction tracking — what was tried, what's closed, what's left (2026-09-06)

Follow-up to report 16. That report concluded live, per-model, switch-following compaction
(the DeepSeek Harness ideal) was "unreachable inside Claude Code," resting on the premise
that the window-belief resolver is effectively read-once for anything beyond the `[1m]`
marker. This report re-opens that premise, finds it half-wrong, and then exhaustively closes
every avenue that half-wrongness suggested. Two paths remain open at the end; neither is
fully automatic without a decision this report does not make for you.

All findings below are from direct reads of the installed `claude.exe` (builds 2.1.259
through 2.1.261 across the investigation), CCR's actual source, and this project's own code
— not from documentation or analogy to other tools. Where a finding was independently
reproduced by a second investigation, that is noted; one investigation (the `hook schema
report.md` audit) also carried a security-classifier flag mid-run for adjacent research, and
its content was independently re-verified rather than trusted on its own signature.

---

## 1. The premise, revisited: the resolver is NOT read-once

Report 16 quoted the resolver as `lU(e,n)`. Rebuilt and confirmed in later binaries as
`Cf(e,t)` / `qL(e,t)`. Traced call sites: `Cf(P,Bf())`, `Cf(r,Bf())`, `Cf(e,Bf())`, and
`zb(e,t,r=Bf())` — the model id is passed **fresh, inline, at every call site**. No memo
wrapper, no session-cached field. **The `[1m]` check and the catalog lookup genuinely
re-evaluate on every context check, including immediately after a model switch.**

The one branch that IS effectively fixed per-process is the env-var fallback
(`CLAUDE_CODE_MAX_CONTEXT_TOKENS`) — but even that branch is not a frozen snapshot. The env
namespace is built as a live property-getter factory:

```js
function f(t,o){let E=Object.create(o);
  for(let[_,r]of Object.entries(t)){let s=E,e;
    Object.defineProperty(E,_,{get:()=>{let n=process.env[_];if(n!==s)e=r.parse(n),s=n;return e},...})}
  return Object.defineProperties(E,{set:{value:(_,r)=>{process.env[_]=String(r)}},
                                    unset:{value:(_)=>{delete process.env[_]}}}),E}
var a=f(DI,T);   // a.CLAUDE_CODE_MAX_CONTEXT_TOKENS re-reads process.env EVERY access
```

**Consequence:** mutating `process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` from inside the
running process would take effect on the very next check, no restart. Report 16's "read at
process start" claim is wrong for this build. This reopened the whole question — hence the
rest of this report.

The gate on that branch, `$L(e)`, returns `false` (env ignored) for a model that resolves via
the catalog or `behavesAs` (i.e. every Anthropic row today), and `true` only for genuinely
unrecognized ids (i.e. every third-party row using the current blanket `behavesAs`, the env
branch is never reached at all — the catalog hit via `behavesAs` wins first).

---

## 2. Why "the resolver isn't cached" doesn't actually solve anything by itself

Being uncached only matters if something can change what the resolver reads, per model, live.
Two theoretical writers exist:

- **`behavesAs`** — a static, per-row string in `settings.json`. Genuinely re-resolved fresh
  on every check (§1), so it DOES track a live switch correctly — but it can only point at one
  of Claude Code's own small set of known Anthropic models. Discrete, not exact. (Full
  treatment of this side in report 18.)
- **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** — a single scalar for the whole process. Live-read, but
  there is exactly one of it. Making it track a switch means something has to rewrite it,
  correctly, every time the user switches, WHILE the process is running. That "something" is
  the entire remaining question this report chases.

`/autocompact <N>` was separately confirmed to be a real, live, in-session mechanism — but it
can only LOWER the effective compaction trigger relative to whatever the resolver above
already decided (`Math.min(believed, configured)`), never raise it. For UW's actual direction
of error (over-declaration via blanket `behavesAs`, not under-declaration), this is sufficient
to get the TRIGGER exactly right — it does not, on its own, make the trigger apply
automatically on every switch. That gap is what the rest of this report is about.

---

## 3. Paths investigated and closed

### 3.1 Bun `bunfig.toml` preload injection — CLOSED, empirically, against the real binary

Hypothesis: Bun standalone executables honor a `bunfig.toml` with a `preload` entry in the
launch working directory, running arbitrary JS in-process before the main bundle loads.
Verified true in general (test executables). Verified **false for this specific
`claude.exe`**, by two independent methods:

- **Static**: the Bun standalone trailer's compile-flags field (`u32` at `magic-5`, found
  immediately before the `---- Bun! ----` trailer magic) was calibrated against 20+ locally
  built executables varying only compile flags, using the exact embedded Bun version
  (1.4.1) rather than an assumed one. `claude.exe`'s value has the bunfig-autoload-disable
  bit **set**.
- **Live, decisive**: ran the real `claude.exe --version` in a scratch directory with a
  marker-writing preload — no marker appeared. A default-compiled Bun 1.4.1 executable, same
  directory layout, same version, **did** produce the marker. Same setup, opposite result —
  rules out the test itself being broken.

**Verdict: closed, not just risky.** Anthropic compiles this build with autoload explicitly
disabled. No in-process code execution is available through this channel, regardless of any
design built on top of it.

### 3.2 Launch-time inspector / debugger attach — technically open, but a standing exposure, not a one-shot

Bun's inspector/debug protocol (WebKit-based, `Runtime.evaluate`-capable) is genuinely
retained in the compiled binary (`--inspect`, `BUN_INSPECT*` strings and implementation
present). Unlike §3.1, this is NOT closed by compile flags. But:

- Only activatable **at launch** — no supported way to enable it on an already-running,
  normally-launched process on Windows.
- Once active, the debug endpoint is open for the **entire session**, not a momentary
  injection — anything on the machine that can reach the loopback port during that whole
  window gets full code execution inside the CLI's own process (files, keys, whatever tool
  permissions have already been granted). This is a materially larger, standing risk than
  §3.1's one-shot idea ever was, precisely because it doesn't close after firing once.
- Untested against the real binary (unlike §3.1, no live experiment was run here).

**Verdict: technically available, not recommended.** Worse risk profile than the closed
bunfig path, and requires permanently changing how Claude Code is launched, every session,
forever.

### 3.3 The hook system — exhaustively closed for command-chaining, three independent audits, full agreement

Three separate investigations (this session's own fork, a second general-purpose re-audit,
and an external audit that additionally traced every command-queue write site by name) all
converged on the same result: **nothing in Claude Code's hook system can cause a second
slash command to execute or queue automatically after a `/model` switch.**

Specifics, most decisive first:

- **The command queue's writers are fully enumerated**: TUI submit (one per Enter), a
  local-jsx dialog continuation, transcript slash-link clicks, plugin `$.prompt.submit`
  (which explicitly **rejects any text starting with `/`**, with the code's own comment
  reading *"a text beginning with / would run a command as the user"* — a deliberate,
  named defense against exactly this pattern), agent messaging (`skipSlashCommands` forced),
  task notifications and poll events (never commands), and session-resurrect (from prior
  legitimate submissions). No hook output field feeds any of these.
- **`PreModelSwitch`** can only allow/deny/ask — no redirect, no injection field exists in its
  schema.
- **`PostModelSwitch`** can only set `additionalContext` — text that reaches the model on its
  NEXT request, costing tokens; it cannot execute or queue anything. Confirmed it is not even
  wired into the one primitive that CAN cause an automatic follow-on action (`continue:false`
  on the Stop family, which re-invokes the model with text — never a command, and not
  supported by `PostModelSwitch`'s consumer at all).
- **`updatedInput`** exists only on `PreToolUse` and `PermissionRequest`(allow) — it rewrites a
  TOOL CALL's arguments, never touches prompt/command text, and cannot change how many
  commands result from one submission.
- **`initialUserMessage`** exists only on `SessionStart`, consumed once at boot before the
  first query. A subagent's own `SessionStart` cannot reach the parent session's queue.
- **The "stacked slash command" feature** structurally excludes `/model` and `/autocompact`
  by type — both are `local`/`local-jsx` commands, and the stacking eligibility check
  explicitly excludes that type from ever being stackable.
- A **full settings.json schema sweep** (~230 keys) found no hidden capability/injection
  field of any kind.

**Verdict: closed, by design, not by omission.** Claude Code's own architecture has a
deliberate, named defense against a hook or plugin submitting a command on the user's behalf.

---

## 4. The two paths that remain open

### 4.1 Manual two-keystroke `/autocompact` flow — verified, safe, costs one extra action per switch

Mechanism: on a model switch where the real context window differs from what Claude Code
would otherwise believe, the picker's handoff writes `/model <provider>/<id>` as today; a
second press of the same picker hotkey, instead of reopening the picker, sees a pending
correction and writes `/autocompact <N>` (the model's real, already-catalogued window) into
the same handoff buffer. Two Enter presses total, both zero-token, both using Claude Code's
own documented, supported commands.

- `/autocompact`'s live-apply path is confirmed: it writes `settings.json` **and** pushes the
  value into live `AppState` via an `apply_flag_settings` merge (`pbe`), which is the only
  thing that changes the running session — writing `settings.json` alone, without the
  command, does **not** take effect live (confirmed: no file watcher on this key, value is
  snapshotted into `AppState` at CLI bootstrap and never re-derived from disk).
- Clamp direction confirmed `Math.min(believed, configured)` — correct for UW's actual
  direction of error (belief too high via blanket `behavesAs`, not too low).
- A companion signal was separately designed and measurement-validated: a `PostModelSwitch`
  hook writing a small marker file, watched by a directory watcher (not a single-file watch,
  which double-fires on rename), delivers a "correction needed now" signal in 52-56ms
  end-to-end on this machine, correctly disambiguates concurrent sessions via the session id
  already present in the hook payload, and recovers cleanly if the watcher was down when the
  event fired. This closes the "how would you even remember to press it again" gap — it
  reminds you at the exact right moment, immediately.
- Terminal-title and desktop-notification alternatives for that same signal were tried and
  found to be dead ends on this machine specifically (not theoretical): only the ACTIVE tab's
  title is reachable at all (a background session's title is structurally invisible), the
  title is clobbered by any prompt framework on every keystroke, and Windows Terminal
  suppresses its toast notification while the tab is focused — which is exactly when the user
  is looking at it during a switch.

**Cost:** one extra keystroke-cycle per switch that needs correction (not every switch — the
picker can skip the second step entirely for a row that's already correct). **Risk:** none —
uses only documented commands, no new attack surface, degrades to "user forgot the second
keystroke" at worst, never to "no protection at all."

### 4.2 OS-level console-input delivery — verified feasible in design, would give full automation, crosses a line this project has not crossed before

Mechanism: `AttachConsole(pid)` + `WriteConsoleInput`, a documented Windows console API that
places raw `KEY_EVENT` records directly into the console's own input buffer — the same buffer
a Node/Bun CLI reads from normally, indistinguishable from physical typing. Confirmed to work
identically under both the classic console host and Windows Terminal's ConPTY architecture
(the buffer exists server-side either way, one step past the VT parser) — this machine's
actual configuration (Windows Terminal + ConPTY) was specifically verified, not assumed.
Corroborated by UW's own already-shipped code: `uwpick-run.ps1` already reads FROM this same
console buffer successfully in this exact environment.

Compared to §3.2's inspector-attach path, this is categorically different and safer: it does
**not** run code inside Claude Code's process at all. It is external automation writing to an
OS-level input buffer — the same category of thing screen readers and RPA tools use to drive
a terminal from outside, not code injection into the target application.

- PID-addressed, focus-independent — no window/tab ambiguity, works while the user has
  clicked elsewhere. `PostMessage`/`SendMessage` window-message approaches were checked and
  confirmed dead against modern Windows Terminal (a WinUI/XAML app that does not process
  synthetic window messages the way classic Win32 controls do). `SendInput` was checked and
  confirmed to require real OS foreground focus, with the worst failure mode of any option —
  misdirected keystrokes landing in whatever unrelated app the user happened to be using.
- Real, honestly-scoped risk: the console input buffer is SHARED by every attached process
  (Claude Code, the parent shell, and the picker while it runs). Writes must be gated on
  "Claude Code is the active reader right now," or keystrokes go to the wrong reader. Bounded
  — misdirection stays inside the same terminal tab (the picker discards on Esc, the shell
  prints an error for an unrecognized command) — never escapes to an unrelated application.
- `WriteConsoleInput` is flagged "not recommended" in Microsoft's own docs (no VT
  equivalent) — a slow-moving, not urgent, future-fragility risk, mitigated by isolating the
  primitive behind one function.
- Genuinely untested by actual execution — a full design, not a proven running thing.

**The tradeoff that matters more than the technical risk:** every other piece of automation
in UW — the picker, keysync, `hud-shim` — stops at "prepare the input, human presses Enter."
That boundary was a deliberate original design choice (the D6 handoff decision: zero
Anthropic tokens, CC saves the input as default, but the human confirms). This mechanism
would be the first thing in UW that submits a command on its own, without that confirmation.
The Windows API itself is legitimate and well-precedented; the effect — a command executing
without the human confirmation step Claude Code's own design deliberately requires — is
functionally the same goal that Anthropic's own safety infrastructure repeatedly and
consistently flagged when researched via other mechanisms (process injection, debugger
attach) during this investigation, even though this specific technique is not itself
code injection. This is a decision for the project owner, not something closed by finding a
cleaner mechanism.

---

## 5. Recommendation

**DECIDED 2026-09-06: §4.1 (Approach A) is locked in as the solution. §4.2 is not pursued.**
Implementation deliberately deferred until the parallel `behavesAs` capability-channel
scoping returns, since both touch the picker's handoff path and the row's context data.
Rationale below stands as written.

Build §4.1 (manual two-keystroke flow, with the validated fast reminder signal) as the actual
solution, not a stopgap. It is fully verified, uses only Claude Code's own documented
commands, has no failure mode worse than "you have to press a key you'd otherwise not need
to," and gets UW to something functionally very close to the DeepSeek Harness ideal for the
one thing that actually matters day to day: compaction firing at the right point. The
remaining gap versus a fully automatic system — one keystroke-cycle per switch that needs
correction — is a UX cost, not a correctness one.

Treat §4.2 as a fully-designed, available option, not a next step to build reflexively. It
should only be pursued if the project owner explicitly decides the automation is worth
crossing UW's own established never-auto-submit boundary — a decision this report
deliberately does not make.

---

## Not verified, and worth stating

- §4.2's design has not been executed once, even in a throwaway scratch terminal. The first
  real step, if pursued, is validating the `INPUT_RECORD` encoding and the shared-buffer
  gating logic in isolation before wiring it into `uwpick.mjs`.
- §3.2's inspector path was investigated by reading embedded strings and consulting official
  docs, not by actually activating an inspector session against this binary — unlike §3.1,
  which had a live positive-controlled experiment. Treat "technically open" there as slightly
  less certain than "technically closed" in §3.1.
- Whether Claude Code's own code detects and reacts to a debugger being attached (§3.2) was
  checked only by static string inspection — absence of an obvious detection string is not
  proof none exists.
- The exact `INPUT_RECORD` construction, delivery latency under real load, and picker-exit
  gating timing for §4.2 remain design sketches, not measurements.
</content>

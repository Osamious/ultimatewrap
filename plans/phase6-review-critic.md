# Phase 6 plan — adversarial review (critic)

**Artifact:** `C:/Users/osami/.uw/plans/phase6-menu-and-catalogue.md`
sha256 `5f47b3e32dba62d7f871d2a817598b67bce6d2e78bfdf2259cf5ae2ba39b5f6a` — verified, matches.

**Verdict: UNSOUND.** 4 BLOCKER, 11 MAJOR, 11 MINOR.

Three of the four blockers are cases where the plan states a safety property in prose,
writes a test that appears to check it, and implements code that cannot deliver it. The
prose is confident enough that a reader who does not trace the call graph will believe it.
That is the failure mode this review is most concerned about, and it is concentrated in
exactly the places the plan is proudest of: the security ordering, the failure behaviour,
and the exact-frame tests.

Phase B's merge policy (B5), the sanitizer's escape handling (A3), the contract-module
boundary (A4), and the dispatcher's *passthrough* branch are genuinely sound and are not
discussed further except where they are consumed by something broken.

---

## BLOCKERS

### BL-1 — The denylist is not on the routing path it is ordered to protect. B2 arms the hijack anyway.

**Anchor:** plan line 4731 (B1 `**Files:**`), line 5012 (B2 implementation comment),
`C:/Users/osami/.uw/keysync/keysync.mjs:193-201`.

Global Constraint 11 (line 23) and the brief both require the denylist to sit on *the real
routing path, not merely the display path*. B1's own file list is:

> **Files:** Create `C:/Users/osami/.uw/menu/denylist.mjs`, Modify `C:/Users/osami/.uw/menu/catalog.mjs`, Test `C:/Users/osami/.uw/test/denylist.test.mjs`

`menu/catalog.mjs` is the **display** path. It feeds `buildSnapshot` → `snapshot.json` → the
picker's renderer. It has no influence whatsoever on what CCR routes.

The real routing path is `keysync.mjs:buildProviders`, which writes CCR's `Providers[].models`:

```js
const ranked = catalogEntries
  .map((m) => ({ m, tier: inferTier(m) }))
  .sort((a, b) => (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) ||
    a.m.model.length - b.m.model.length);
for (const { m, tier } of ranked) {
  if (models.length >= MAX_MODELS_PER_PROVIDER || seen.has(m.model)) continue;
  models.push({ id: m.model, tier, contextTokens: m.limits?.contextTokens });
```

There is no `admitRemoteModels` call, no `isReserved` check, and no import of
`menu/denylist.mjs` anywhere in that file — before or after B1. B1 does not modify
`keysync.mjs` at all.

B2 then edits exactly this file to make `inferTier` work, and its own comment asserts the
mitigation is in place:

> SEQUENCING: this fix is what makes free-first functional, which is what makes
> a hostile zero-priced "opus" sort to the top. The reserved-name denylist in
> menu/denylist.mjs MUST be in place first. **It is.**

It is not. A hostile aggregator publishing `{"id":"opus","pricing":{"offers":[{"per1MTokens":{"input":0,"output":0}}]}}`
sorts to rank 0 after B2 (free-first, then shortest-id — `opus` is 4 characters), lands in the
top-`MAX_MODELS_PER_PROVIDER` slice, and is written into CCR's config. That is report 08 F1
exactly. The plan ships the sort fix and mitigates it on a surface that does not route.

**Why it bites at runtime:** silently. The user sees nothing. Full system prompt, tool
definitions and file contents route to an attacker-chosen host on CCR's cross-provider
fallback.

**Fix (surgical):** add `keysync/keysync.mjs` to B1's Files list. Import
`admitRemoteModels` and filter `catalogEntries` (and `vp.testModel`) at the top of the
`buildProviders` loop, before `ranked` is computed:

```js
const { kept } = admitRemoteModels(reg.provider, catalogEntries.map((m) => m.model));
const keptSet = new Set(kept);
const catalogEntries2 = catalogEntries.filter((m) => keptSet.has(m.model));
```

Add a test in `denylist.test.mjs` that calls `buildProviders` with a hostile `opus` entry
and asserts it is absent from the returned `Providers[].models` — an assertion about the
routing output, not about `buildFrom`.

---

### BL-2 — `uwpick.cmd` exits 0 unconditionally, so every documented abort path injects `m` into the chat input.

**Anchor:** plan line 3578 (A13 Interfaces: "Produces: **exit code 0 always**"), line 3715
(`exit /b 0` after the PowerShell call), against Q2.1 (line 55), Q2.2 (line 56), Q2.6 (line 60).

The plan's failure contract is stated four times and always the same way. Q2.1:

> the picker prints one line naming the file and the `uw catalog refresh` command that rebuilds it, then **exits 1 so the chat input is left untouched**

Q2.6:

> the wrapper prints `uwpick: cannot open CONIN$` with the Win32 message and **exits 1, and Claude Code discards the buffer**

Both are false as built. The chain is `$EDITOR` → `uwpick.cmd` → `uwpick-run.ps1` → `node uwpick.mjs`.
The `.ps1` correctly propagates (`exit $childExit`, line 3552). The `.cmd` then throws it away:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uwpick-run.ps1" -File "%BUF%"
exit /b 0
```

Claude Code only sees the dispatcher's exit code. Exit 0 means **accept the buffer**. The
buffer at that moment still contains the sentinel the user typed — `m`. So on a missing
snapshot, a wrong `schemaVersion`, a `CONIN$` failure, or an uncaught exception, the user's
chat input becomes the literal string `m`.

The exit-0 reasoning is correct for the *passthrough* branch and was copied to the *picker*
branch where it inverts:

> REM not ours -> hand off to the real editor, unchanged. Exit 0 regardless: a
> REM non-zero exit makes CC DISCARD the buffer, so a failing editor would silently
> REM eat the user's typed input.

For passthrough, the buffer holds the user's real prose and discarding it is the harm. For
the picker, the buffer holds a three-character sentinel and *keeping* it is the harm.

The same defect makes the Esc-quit path wrong. In `uwpick.mjs` (line 3149):

```js
const finish = (target) => {
  let wrote = false;
  try {
    if (FILE && target != null) { fs.writeFileSync(FILE, modelCommand(...)); wrote = true; }
  } catch { }
  ...
  process.exit(CONTRACT.handoff.acceptExit);      // MUST be 0, or CC discards the content
};
```

`finish(null)` — reached from Esc, ctrl+c, and the `CONIN === null` branch — writes nothing
and exits 0. Q2.3's "the picker runs normally" and the Esc ladder's documented "quits" both
leave `m` in the chat input.

**Why it bites at runtime:** every single abort. This is the most user-visible defect in the
plan and it fires on the most common non-selection action (Esc).

**Fix (surgical, one line each):**
1. In `uwpick.cmd`'s `:pick` branch, replace `exit /b 0` with `exit /b %ERRORLEVEL%`. Leave
   the passthrough branch at `exit /b 0`.
2. Independently, in `finish()`, truncate the buffer on abort so the outcome is correct even
   if an exit code is ever swallowed again:
   ```js
   if (FILE && target == null) { try { fs.writeFileSync(FILE, ""); } catch {} }
   ```
   An empty buffer yields an empty chat input regardless of exit code, which is the property
   Q2.1–Q2.6 actually want.
3. Add a dispatcher test asserting a non-zero child produces a non-zero `uwpick.cmd` exit
   for the sentinel path and zero for the passthrough path. A13's current tests assert only
   *which* program ran.

---

### BL-3 — The routability redraw and the resize handler can never run. Q1.3 is dead code.

**Anchor:** plan line 3143 and lines 3160-3175 (A10), against Q1.3 (line 51) and Q7.2 (line 101).

`main()` fires the RPC and then enters a synchronous infinite loop:

```js
routableSet({ timeoutMs: 400 }).then((r) => { routable = r.set; draw(); }).catch(() => {});

if (out.isTTY) out.on("resize", () => draw());
...
for (;;) {
  let n = 0;
  try { n = readSync(CONIN, buf, 0, buf.length, null); }
```

`readSync` is a blocking libuv call on the main thread. The `for(;;)` body contains no
`await`. The JS stack never unwinds, so the event loop is never re-entered and the microtask
queue never drains. The `.then()` callback and the `resize` listener are therefore
unreachable for the entire life of the process — `main()` only returns via `process.exit()`
inside `finish()`.

The plan knows this. Q7.2 states it as a design constraint:

> The input loop is a blocking `readSync` on `//./CONIN$`, so there is no event loop while a key is awaited and timer-driven idle animation is impossible without a worker thread.

and then Q1.3 assumes the opposite:

> `uwpick.mjs` draws from the snapshot plus a cached routable set, then issues the RPC with a 400 ms timeout and **redraws the dim state when it returns**

Both cannot be true. The comment at line 3142 — "Only now, with a frame already on screen,
do we ask the gateway anything" — describes an intent the architecture forbids.

**Why it bites at runtime:** non-routable rows never dim. The dim state is the only signal
that a selection will fail, so the picker will confidently offer models CCR cannot resolve
and the user finds out after switching. Separately, resizing the terminal mid-session leaves
a corrupted frame until the next keystroke, because `reduce(state, {resize})` only runs
inside `draw()` on the key path.

Note this also makes `routableSet`'s 400 ms budget, its cache-write behaviour, and
`~/.uw/state/routable.json` pointless in the picker: the set is always the empty
`new Set()` from `firstFrame`, and `style.mjs` line 2777 (`if (!routable.has(it.target) && routable.size)`)
correctly no-ops on an empty set, so nothing ever dims.

**Fix — pick one, do not keep both claims:**
- *Matches Q7.2:* resolve routability from cache only. `cachedRoutable()` is already
  specified in A5 and is synchronous. Drop the live RPC from the picker entirely and let the
  refresher (B6/B10) write `routable.json`. Delete Q1.3's redraw sentence and the `.then()`.
  Resize is then handled on the key path only, which `draw()` already does. (Awaiting the RPC
  before the first draw is not an option — it blows the 300 ms budget.)
- *If the live redraw is genuinely wanted:* the read must become non-blocking — poll
  `readSync` on a handle opened with a short timeout, or move the console read to a worker
  and `await` a message. Both contradict Q7.2 and are much larger than "no worker thread is
  added" permits. Recommend the first option.

---

### BL-4 — Task A9's own exact-frame tests contradict Task A9's renderer, and `pad()` strips the colour it is padding for.

**Anchor:** plan lines 2494-2506 (the two exact-line tests), line 2677 (`pad`), lines
2769-2772 (the badge cell), line 2588 (`FRAME_W = 78`).

Three compounding defects in one task, all provable by arithmetic.

**(a) `pad()` destroys colour.**

```js
const pad = (s, n) => sanitizeDisplay(String(s ?? ""), n).padEnd(n);
```

`sanitizeDisplay` strips CSI sequences by design (A3). The badge cell passes an
*already-coloured* string into it:

```js
pad(badgeColour(m.badge) ? p[badgeColour(m.badge)](m.badge) : m.badge,
    W.badge + (badgeColour(m.badge) ? 9 : 0)) +
```

So `pad(p.grn("FREE"), 15)` → `sanitizeDisplay("\x1b[32mFREE\x1b[0m", 15)` → `"FREE"` →
`padEnd(15)`. The badge renders **uncoloured**, defeating Q7.1's palette, and the `+9`
compensation becomes 9 stray spaces. The `+9` is also wrong on its own terms: it assumes a
9-character SGR wrapper, but `p.dim` (used for `PAID`) is `\x1b[2m…\x1b[0m` = 8, and
`p.ramp`'s 256-colour form is 11+ per character.

**(b) The width invariant test fails.**

Model row visible width = 1 (mark) + 1 + 34 (`W.id`) + 6 (`W.ctx`) + 1 + 7 + 7 + 2 + **15**
(badge, inflated) + 3 (caps) = **77**. `INNER = FRAME_W - 4 = 74`. `bar()` only pads, never
truncates:

```js
return `${g.frame.v}${body}${" ".repeat(Math.max(0, INNER - visible))} ${g.frame.v}`;
```

so the line comes out at 1 + 77 + 0 + 1 + 1 = **80**, and this test fails:

> `test("every line of every frame is exactly FRAME_W visible columns"` … `assert.equal(strip(l).length, FRAME_W, ...)`

With a correct 6-wide badge the row is 68 → fits. So the invariant test is right and the
renderer is wrong.

**(c) Both hand-written expected rows are off by one, in opposite directions.**

Level 1 expects:
```js
"|> gemini-3.5-flash-lite" + " ".repeat(13) + "    1M    0.00    0.00  FREE  " + "TVR" + " ".repeat(4) + " |"
```
That literal reserves **6** columns for the badge (`FREE` + 2 trailing), i.e. it was written
against `pad(badge, W.badge)`, not against `W.badge + 9`. It also places the second price
one column right of what `rpad(money, 7)` produces.

Level 0 expects `"personal.google.free" + " ".repeat(11)` before the model count.
`"personal.google.free"` is 20 characters; `pad(..., W.keyId=30)` yields **10** trailing
spaces, not 11.

These expectations were composed by hand and never executed. That matters beyond the two
lines: the plan calls this the test that "a styling change that breaks alignment fails a test
rather than an eyeball" (line 158), and A9's Step 4 says `# fail 0`. As written, A9 cannot
reach its own Step 4.

**Fix (surgical):**
1. Colour after padding, never before: `const cell = pad(m.badge, W.badge); … badgeColour(m.badge) ? p[badgeColour(m.badge)](cell) : cell`. Delete the `+9`.
2. Regenerate the two expected literals by running `frame()` once and pasting the output —
   then re-derive them by hand once to confirm the column maths, so the test is not simply
   a transcript of whatever the code does.
3. Make `bar()` truncate as well as pad (`strip`-aware) so an overflow degrades to a clipped
   row instead of a broken frame.

---

## MAJOR

### MJ-1 — `consecutiveFails` has no producer anywhere in the plan; the health column can never say "broken" from probe data.

**Anchor:** plan line 6255 (`resolveHealth`), lines 5703/5709 (`mergeProvider`), line 6292.

`resolveHealth` keys its entire probe-derived verdict on one field:

```js
if ((entry?.consecutiveFails ?? 0) >= 3) return "broken";
```

`consecutiveFails` appears in the plan **only** inside `health.mjs` and its tests, plus the
file-structure table at line 246. Nothing computes it. B5's `mergeProvider` — the only thing
in the plan that produces `lastOk`/`lastFail` — emits:

```js
{ models, lastOk, lastFail, stale, staleSince, count }
```

no `consecutiveFails`. So B7's claim at line 6292 is factually wrong:

> Tier 2 and tier 3 produce **exactly** the `{lastOk, lastFail, consecutiveFails}` shape it wants, so wiring the refresher's outcomes into it is a two-line follow-up

It is not a two-line follow-up; the counter does not exist and cannot be derived from a
single run's outcome — it requires carrying the previous count forward through the merge.

**Fix:** add `consecutiveFails` to `EMPTY` and to both branches of `mergeProvider`
(`ok` → `0`; `soft`/`hard` → `(base.consecutiveFails ?? 0) + 1`), and add a merge test that
drives three consecutive `soft` outcomes and asserts `3`. Then the "two-line follow-up"
becomes true.

### MJ-2 — `health.json` has no writer, so every provider renders `stale` forever. The existing probe scripts are orphaned.

**Anchor:** plan line 6292; `keysync/key-health.mjs`, `key-health-reprobe.mjs`,
`key-health-live3.mjs` — **0 occurrences** in the plan.

With no `health.json`, `readHealth()` returns `{generatedAt: null, providers: {}}`, so
`age = Infinity`, so `resolveHealth` returns `"stale"` (or `"needs $"`) for every provider
whose notes do not match `BROKEN_NOTES`. One of exactly four provider columns
(Constraint 6, width 8) ships showing the same value for all 44 rows.

The deferred section discloses this honestly, which is why it is MAJOR and not a blocker.
But three probe scripts that already exist and already produce per-provider outcomes —
`key-health-latest.json` and `key-health-reprobe.json` are on disk right now — are never
mentioned. The plan invents a new producer it then does not build, while an existing one
sits unreferenced.

There is also no `testModelVerifiedAt`-style freshness field anywhere, even though
`buildFrom` prepends `prof.testModel` as the *leading* model row with a blank badge and
`buildProviders` gives it rank 0 on the routing path. A stale `testModel` is therefore both
the first thing the user sees and the first thing CCR routes, with no signal attached.

**Fix:** add a step to B7 that reads `keysync/key-health-latest.json` (and
`last-test-results.json`) and folds them into `health.json` through `writeAtomic`. That is
the shortest path to a non-`stale` column and it reuses measured data instead of waiting on
tier 2. Add `testModelVerifiedAt` to the provider profile and surface it in the health cell
or as a dimmed suffix on the leading row.

### MJ-3 — `Set-Content -Encoding UTF8` in PowerShell 5.1 writes a BOM, which will break `settings.json` for Claude Code and every UW JSON reader.

**Anchor:** plan lines 4574, 4590, 4592 (`install.ps1`), line 3550 (`conmode.json`).

PS 5.1's `-Encoding UTF8` is UTF-8 **with** BOM. Three files are written this way:
`settings.json`, `hud-install.json`, `conmode.json`.

`JSON.parse` throws on a leading `\uFEFF`. The project already knows this — `keysync.mjs:19`
strips it explicitly:

```js
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
```

but `menu/atomic.mjs:readJsonOr` (A5) has no such strip, so `conmode.json` and
`hud-install.json` will silently return the fallback — A12's console-mode test and A15's
`checkHud` will read empty objects and draw wrong conclusions.

Worse, `install.ps1 -Hud` rewrites Claude Code's live `settings.json` with a BOM. This is the
one file in the plan that a third party parses and that the user depends on for every
session.

**Fix:** use `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))`
in all three places, and add the BOM strip to `readJsonOr`. Add an assertion to A16's test
that the first byte of the written `settings.json` is not `0xEF`.

### MJ-4 — The HUD uninstall is not byte-for-byte, despite being claimed four times; the backup that would make it so is never read.

**Anchor:** plan lines 4568-4576 (`-HudUninstall`), line 4589 (`Copy-Item … .uw-bak`),
against Q6.3 (line 89), the ADR (line 182), A16 Interfaces (line 4347).

The claim: "the install records the previous `statusLine.command` verbatim so uninstall
restores it **byte for byte**". The implementation restores one *value* and then
re-serialises the whole document:

```powershell
$json.statusLine.command = $prevHud.previousCommand
($json | ConvertTo-Json -Depth 20) | Set-Content -Path $settingsPath -Encoding UTF8
```

A `ConvertFrom-Json`/`ConvertTo-Json` round trip in PS 5.1 reformats indentation, re-escapes
non-ASCII to `\uXXXX`, and normalises number formatting. The plan acknowledges the reformat
at line 4593 and then still calls the result byte-for-byte. The `.uw-bak` copy — which *is*
the original bytes — is created and never used by any code path.

**Fix:** have `-HudUninstall` restore from `$settingsPath.uw-bak` when its recorded
`previousCommand` matches, using the value-edit path only if the backup is absent or has
drifted. Or drop the "byte for byte" claim from all four places. Do not keep both.

### MJ-5 — B2's "denylist landed first" gate is a commit-message grep.

**Anchor:** plan lines 4958-4964.

```js
const log = execFileSync("git", ["-C", "C:/Users/osami/.uw", "log", "--oneline", "-40"], ...);
assert.match(log, /reserved-name denylist/, ...);
```

This asserts that a string appears in a commit subject. `git commit --allow-empty -m
"reserved-name denylist"` satisfies it. It checks nothing about whether `denylist.mjs`
exists, is imported, or is reachable from the routing path — which, per BL-1, it is not.

The risk table at line 6737 then names this test as the mitigation for the very risk it
cannot detect: "The test in B2 asserts B1 is in the git log and fails loudly if it is not."

**Fix:** replace with a behavioural assertion —
`import { buildProviders } from "../keysync/keysync.mjs"`, feed a hostile `opus` entry, and
assert it is absent from the output. That test fails today and passes only once BL-1 is
fixed, which is exactly the gate that was wanted.

### MJ-6 — `infertier.test.mjs` reads live production state and is documented as failing on first run, breaking the `# fail 0` gate every later task depends on.

**Anchor:** plan lines 5040-5046, and line 5006.

```js
const cat = JSON.parse(fs.readFileSync("C:/Users/osami/.uw/catalog/models.json", "utf8"));
```

Global Constraint 15 says scratch state goes under `~/.uw/harness/scratch/`. This reads a
live artifact — 19.7 MB, on the machine, produced by B4 which runs *after* B2. The plan
concedes it:

> on first run that one test fails with `ENOENT ... catalog\models.json` and is the signal to proceed to B4

Every task from B2 onward states an expected result of the form `# pass N`, `# fail 0`. With
a known-failing test in the suite, that gate is unreadable: a real regression is
indistinguishable from the expected failure, and the pass counts (199, 249, 268 …) are wrong
until B4 lands.

**Fix:** move the corpus assertion into a standalone script (`test/corpus-tier.mjs`, in the
style the plan already uses for `bench-startup.mjs`) run explicitly after B4, or gate it on
`fs.existsSync(...)` and skip when absent. Either keeps the suite at `# fail 0` throughout.

### MJ-7 — The startup benchmark does not measure the budget it gates.

**Anchor:** plan lines 3330-3348 (`CHILD`), line 3138 (`recordStartup`), Q1.2 (line 48), Q1.4 (line 53).

Q1.2 defines the budget as "process start to **the first frame reaching the console**", and
Q1.4 puts the startup animation inside it. The bench child does neither:

```js
const f = firstFrame({ snap: r.snap, recents: [], favourites: [],
                       caps: detectCaps({ TERM: "dumb" }, 80), termRows: 30 });
if (!f.text.length) { process.exit(4); }
process.stdout.write(String(Number(process.hrtime.bigint() - t0) / 1e6));
```

It builds a *string*, never writes it to a console, and forces `TERM: "dumb"` so
`motionEnabled` is false and `run("open")` is never exercised. Meanwhile the runtime path
records a different quantity — `recordStartup` at line 3138 fires *after*
`out.write(HIDE + CLEAR)` and `run("open")`, so `startup.json` includes up to 3 × `FRAME_MS`
of `sleepSync` that the bench excludes. Two incompatible numbers are compared against one
300 ms budget.

The bench's diagnostic hint is also misleading: it warns that reaching `keysync.mjs` "pulls
in a PowerShell round trip". It does not — `keysync.mjs` is 319 lines of pure declarations
with no top-level side effects; its PowerShell round trip is inside `keyReader`, at call
time. The hint sends a future debugger down a dead end.

**Fix:** have the child render to a pipe and time to the completed `write`, with motion
enabled and `TERM` inherited; and move `recordStartup` to the same point so the two numbers
are comparable. Correct the diagnosis note.

### MJ-8 — `priceOf` and `inferTier` read the first offer regardless of which provider it prices. The plan documents the bug and ships it.

**Anchor:** plan lines 1244-1254 (`priceOf`), lines 5030-5040 (`inferTier`).

`inferTier`'s own comment:

> An offer can price a model at a DIFFERENT provider (`offers[].provider` is its own field, and merged records carry up to 16 offers), so this takes the first offer carrying both token prices rather than folding all of them — folding would answer "is this free anywhere", not "is it free on my key".

Taking the *first* offer does not answer "is it free on my key" either. It answers "is the
first offer in an arbitrarily ordered array free". For a merged record with 16 offers, the
first one is very likely a different host. The comment correctly rejects the wrong
alternative and then implements a second wrong alternative.

**Why it bites:** a `FREE` or `FREE?` badge on a model that bills on the user's key. That is
precisely the class of lie Principle 1 ("Blank beats a guess", line 108) exists to prevent.
It also feeds BL-1: a mispriced-as-free entry sorts to rank 0 on the routing path.

**Fix:** both functions already have the provider name at every call site (`buildFrom` has
`cred.provider`; `buildProviders` has `reg.provider`). Pass it and prefer
`offers.find(o => o.provider === providerName)`; fall back to blank/`unknown` — not to
offer 0 — when no offer matches. Five lines, and it makes the badge honest.

### MJ-9 — `sanitizeDisplay` does not address the display-spoofing and width classes it is the sole defence for.

**Anchor:** plan lines 626-636 (A3 implementation), Constraint 13 (line 25).

`ESC_SEQ` and `CTRL` are correct and cover report 08 F3. Three gaps remain, and A3 is the
only place they could be closed:

- **Bidi overrides.** `\u202E` (RLO), `\u200F`, `\u2066`-`\u2069` are not C0/C1 and survive.
  A model id containing RLO renders reversed in Windows Terminal — a direct spoofing
  primitive for exactly the Anthropic-lookalike attack B1 exists to stop.
- **Zero-width and combining marks.** `\u200B`, `\u0301` etc. survive, count as length in
  `.slice`/`.padEnd`, and occupy 0 display columns — silently shortening every padded cell.
- **Surrogate pairs and wide characters.** `.slice(0, max)` counts UTF-16 code units, so an
  astral character at the boundary is cut into a lone surrogate. East Asian wide and
  ambiguous-width glyphs count as 1–2 units but occupy 2 columns, so the exact-frame tests
  and `bar()`'s `strip(body).length` both under-count. This also applies to the plan's own
  Unicode glyph set (`●`, `▰`, `▶`) under fonts that render them double-width.

The bundled catalogue is clean today; the plan says so and correctly notes that is "a
property of today's data, not an enforced invariant" (line 610). B6 then introduces remote
listings, at which point it stops being true.

**Fix:** add to `sanitizeDisplay`, in order — strip
`/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g`; NFC-normalise; then slice by
`[...s]` code points rather than code units. A full width-aware pad is a larger change and
can be deferred, but the bidi strip is one regex and closes a spoofing hole.

### MJ-10 — The denylist ships 17 tasks after the renderer it protects.

**Anchor:** task ordering — A5 (line 967) renders untrusted ids; B1 (line 4729) filters them.

Constraint 11 orders B1 before B2, and the plan honours that. But B1 consumes nothing
(`**Interfaces:** Consumes: nothing`) and is ~40 lines. There is no dependency reason it sits
in Phase B. Between A5 and B1 — which is the entire shippable menu, including A17's live
protocol against real Claude Code — a spoofed `opus` row renders under any provider.

Principle 3 says "Security ordering is part of correctness. … A correct change applied in the
wrong order is a regression." That reasoning applies to its own placement.

**Fix:** move B1 to sit immediately after A3 (it depends only on `admitId`). The `buildFrom`
edit it carries then lands with A5 rather than as a later patch, which also removes the
awkward "replace the whole loop" diff at line 4900. Note that A6's own fixture uses
`M("opus-lookalike")` as a legitimate row (line 1473) — a name the denylist rejects — so that
fixture needs renaming in the same pass.

### MJ-11 — `settings.json` is written non-atomically, and it is the only third-party live file the plan touches.

**Anchor:** plan line 4592, against Q2.8 (line 63).

Q2.8 enumerates every file written through `writeAtomic` — `picker.json`, `routable.json`,
`startup.json`, `health.json`, `capabilities.json`, `install.json`, `snapshot.json`, the
`current` pointer. `settings.json` is absent, and `install.ps1` writes it with a plain
`Set-Content`. A ctrl+c or a full disk between truncate and write leaves Claude Code with a
truncated config.

The `.uw-bak` copy taken immediately before is real mitigation, which is why this is MAJOR
and not a blocker — but the recovery is manual and undocumented in the risk table.

**Fix:** write to `settings.json.uw-tmp` and `Move-Item -Force` over the target (NTFS rename
is atomic for a same-directory target — the plan already relies on this in `atomic.mjs`).
Add a row to the risk table naming `.uw-bak` as the recovery.

---

## MINOR

- **MN-1 — `healthDot` does not encode state in the glyph, contradicting its own test name.**
  Lines 2661-2665 return `g.dotOk` for `broken`, `needs $` and `ok` alike; only the fallthrough
  uses `g.dotStale`. The test at line 2467 is titled "the health dot carries the state in the
  glyph as well as the colour" and then asserts `strip(healthDot("ok")) === "●"` and
  `strip(healthDot("broken")) === "●"` — proving the opposite. In ASCII/no-colour mode
  (`painter` returns `String(s)` unchanged when `caps.colours === 0`) `ok` and `broken` are
  both `"*"` and indistinguishable. *Fix:* `broken` → a distinct `g.dotBad` (`"✖"`/`"x"`),
  `needs $` → `g.dotWarn` (`"◐"`/`"$"`), and fix the test to assert inequality of the
  stripped glyphs.

- **MN-2 — the health cell truncates its own longest value.** Line 2762 pads to
  `W.health - 2` = 6; `"needs $"` is 7 characters, so `sanitizeDisplay(s, 6)` clips it to
  `"needs "`. The ASCII mock at line 2333 shows `● needs $` in full, so the mock and the code
  disagree. *Fix:* widen the cell to `W.health` and account for the dot separately, or
  shorten the label.

- **MN-3 — level-0 header is one column wider than its rows.** Header (line 2740) is
  `pad("free", W.bar + W.free)` = 18; the row emits `proportionBar` (5) + `" "` (1) +
  `pad(freeTxt, W.free - 1)` (11) = 17. Everything from `free` rightward is misaligned by one.
  *Fix:* make `proportionBar`'s default width `W.bar` (6), or the header `W.bar + W.free - 1`.

- **MN-4 — `buildFrom`'s declared signature omits two parameters its own tests require.**
  Line 979 declares `buildFrom(input: {chosen, providers, catalog, relay?})`, but the A5 test
  at line 1113 passes `cadenceOf` and B7 line 6270 adds `healthOf`. *Fix:* update the
  Interfaces line to `{chosen, providers, catalog, relay?, cadenceOf?, healthOf?}`.

- **MN-5 — protocol step count disagrees with itself.** Test Strategy (line ~6721) says
  "Task A17's **twelve**-step protocol"; the RALPLAN summary (line 162) and A17 itself both
  have **fifteen** (`P1`–`P15`). *Fix:* say fifteen.

- **MN-6 — A4's Interfaces summary omits `CONTRACT.paths` and `statusline.displayPath`,**
  both of which exist in the implementation (lines 840-846) and are consumed by A16 line 4347.
  The summary is what a reviewer checks A16 against, so the omission reads as a missing field.
  *Fix:* add them to the Interfaces block.

- **MN-7 — the boundary grep only scans `.mjs`, exempting the two files most likely to
  hard-code a Claude Code path.** Line 815: `if (allowed.has(f) || !/\.mjs$/.test(f)) continue;`.
  `install.ps1` names `settings.json` and `uwpick.cmd` names the wrapper. Q4.3 says "No other
  file in the repository". *Fix:* extend to `/\.(mjs|ps1|cmd)$/` with an explicit, commented
  allowlist for the two known paths, so a *new* hard-coded path still trips.

- **MN-8 — `menu/catalog.mjs` is listed as both Created (line 195) and Moved (line 251).**
  Harmless, but it makes the file table unreliable as a checklist. *Fix:* keep it in Moved
  only; A5's Files line already says `Modify`.

- **MN-9 — `CONTRACT.bundledCatalogue` hard-codes `C:/nvm4w/nodejs/node_modules/...`** (line 913)
  with no discovery and no doctor check. `nvm4w/nodejs` is a junction that follows the active
  Node version, so it survives version switches, but an `npm i -g` relocation or a different
  Node manager breaks it silently. B4's copy-out reduces the blast radius to refresh time.
  *Fix:* add a `bundled-catalogue` check to A15's doctor that asserts the path exists and
  names the fix.

- **MN-10 — `catalog.mjs` uses top-level `await import()` for a static dependency** (line 1231).
  `const K = await import("file://" + KEYSYNC...)` makes every importer of `catalog.mjs` —
  including `snapshot.mjs` and the bench child — async-load `keysync.mjs`. It is cheap in
  practice (no top-level side effects) but it is a dynamic import with no dynamic reason, and
  it slightly undercuts A5's stated rationale that the split keeps tests off the live vault.
  *Fix:* a static `import * as K from "../keysync/keysync.mjs"`.

- **MN-11 — VT *output* processing is assumed, never set or detected.** `uwpick-run.ps1`
  sets `ENABLE_VIRTUAL_TERMINAL_INPUT` on `CONIN$` only. The picker writes `\x1b[H`, `\x1b[2J`
  and SGR to stdout, which requires `ENABLE_VIRTUAL_TERMINAL_PROCESSING` (0x0004) on `CONOUT$`.
  `detectCaps` guesses from environment variables, which is not the same thing — and under a
  bare conhost with no `WT_SESSION`/`TERM`, `detectCaps` returns `vt: false` while `paint()`
  and `CLEAR` still emit escapes unconditionally. In practice Claude Code has already enabled
  output VT on the shared console, so this works. *Fix:* one sentence in the wrapper's header
  recording that output VT is inherited from the host and deliberately not set here, so the
  next person does not spend an hour on it.

---

## Sections that are sound

B5's merge policy — `classify`, the `SHRINK_FLOOR`/`SNAPSHOT_FLOOR` guards, and the
separate-lock rationale — is the strongest part of the plan and I found nothing to attack in
it. A3's `ESC_SEQ`/`CTRL` regexes and the strip-vs-reject split are correct as far as they go
(MJ-9 is about what they omit, not what they do). A4's contract isolation is a real boundary,
and B4 correctly widens the grep to `keysync/` once that directory is clean. A12's PowerShell
wrapper is faithful to every measured Windows fact — decimal access mask, `CreateFile` on
`CONIN$` rather than `GetStdHandle`, `ENABLE_PROCESSED_INPUT` left unset so ctrl+c arrives as
byte 3, mode `0x280`, restore in `finally`, exit-code propagation — with only the BOM issue
(MJ-3) against it. A7's atomic state handling and A8's four-outcome `loadSnapshot` are clean.

---

## Minimum set to reach SOUND-WITH-CHANGES

1. BL-1: wire `admitRemoteModels` into `keysync.mjs:buildProviders`, and replace MJ-5's
   git-log grep with an assertion on `buildProviders`' output.
2. BL-2: `exit /b %ERRORLEVEL%` in the `:pick` branch, plus truncate-on-abort in `finish()`.
3. BL-3: drop the live RPC from the picker in favour of `cachedRoutable()`, and delete Q1.3's
   redraw claim and the dead `resize` listener.
4. BL-4: colour after padding, delete the `+9`, regenerate both expected frame literals.
5. MJ-1 + MJ-2: add `consecutiveFails` to `mergeProvider`, and populate `health.json` from
   the existing `key-health-latest.json`.
6. MJ-3: BOM-free writes in all three PowerShell sites, plus a BOM strip in `readJsonOr`.
7. MJ-6: take the live-corpus assertion out of `node --test` so `# fail 0` means something.

MJ-8 (offer/provider matching) should land in the same pass as BL-1: both touch the same two
functions, and a mispriced-as-free entry is what sorts a hostile id to rank 0.

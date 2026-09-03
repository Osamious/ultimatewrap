# Phase 6 plan — targeted delta re-review (critic, pass 3)

**Artifact:** `C:/Users/osami/.uw/plans/phase6-menu-and-catalogue.md`
**Snapshot reviewed:** sha256 `4b966e746708afba446493bee7cbdfbfcd64e1bdfcd3e9f76086fd7fd0cc87d2`, 9,444 lines —
verified at the start of this pass and matching the assignment anchor exactly. The file did not
move during the review; the freeze held.

**Verdict: UNSOUND.** 1 BLOCKER, 2 MAJOR, 2 MINOR new.
Of my nine round-2 findings: **6 RESOLVED, 1 PARTIALLY RESOLVED, 2 NOT RESOLVED.**

The substantive engineering in this revision is sound. The `Entry` type now runs end to end and
`mergeEntries` genuinely preserves pricing; the width path is genuinely unified and I could not
break it. What failed is mechanical: five code blocks in the plan do not parse, and two round-2
fixes were written but never executed, so they assert things their own code contradicts. Every
finding below was produced by running the plan's code, not by reading it.

---

## Round-2 findings

| # | Status | Evidence |
|---|---|---|
| NB-1 (BLOCKER) | **PARTIALLY RESOLVED** | The pipeline is fixed: `tier1` keeps models.dev's per-model object (L8218–8219), `tier2` mints `{model: id}` with no `pricing` key (L8251), `writeSnapshot` throws by name on a non-`Entry` (L8888–8891), the `m.model ?? m` coercion is gone, and B5's `E()`/`ids()`/`EMPTY_FIXTURE` helpers make one type authoritative in that file. `mergeEntries` (L7735) traces correctly under every order I tried — see below. But three tests in `tiers.test.mjs` still assert the retired `string[]` shape; see NC-2. |
| NB-2 (MAJOR) | **NOT RESOLVED** | Executed. The renderer emits `2` at index 39; the literal (L3327) asserts `3`. Detail below. |
| NB-3 (MAJOR) | RESOLVED | The badge-colour test now builds `V1U` with `cursor: 1` and a second item (L3376–3377) and asserts against the unselected row; the comment at L3369–3375 states why. |
| NB-4 (MAJOR) | RESOLVED | `vis()` (L3652) is authoritative in `pad`, `rpad`, `clipVisible`, `bar`, `title`, `footer` and the meta gap. I recomputed nine cases; all land at exactly 78 code points. One residual measure remains — NC-3. |
| NB-5 (MINOR) | RESOLVED | `safeTestModel` is guarded on `vp.testModel` before the call (L2089–2091), so `admitId(undefined)` is never reached. |
| NB-6 (MINOR) | RESOLVED | `menu/set-statusline.mjs` (L254) and `refresh/health-writer.mjs` (L259) are both in the Created table. |
| NB-7 (MINOR) | RESOLVED | The bare `catch` is gone (L4578–4585): timeout, `ENOENT` and an unexpected exit code each produce a named note, and only `e.status === discardExit` is silent. |
| NB-8 (MINOR) | **NOT RESOLVED** | `main` is no longer `async` (L4232), but the new `assert.doesNotMatch(src, /await/)` (L4004) fails against the file it reads. Detail below. |
| NB-9 (MINOR) | RESOLVED | The instruction precedes the query and the filter is clipped to 20 (L3772). Recomputed: the line is 72 columns against `INNER` = 75, so it no longer clips at all. |

### `mergeEntries`, checked under every merge order

`mergeEntries(prev, next)` (L7735–7742) keys `prev` by `model`, lets `next` decide membership,
and for a surviving id returns `next` when it carries `pricing`, otherwise `{...old, ...next,
pricing: old.pricing}`. The three reachable orders behave correctly:

- tier 1 then tier 2 (the case the round-2 blocker was about): `next` is `{model}` with no
  `pricing`, so the else branch restores `pricing` *and* `limits` and `modalities` from `old`.
- tier 2 then tier 1: `next` carries pricing and wins wholesale, which is right because tier 1's
  record is a superset of tier 2's.
- an id new to this run: returned as-is, with no `pricing` key invented.

The one order that loses data is `old` carrying `limits` but no `pricing` while `next` carries
`pricing` but no `limits` — the first branch discards `old` entirely. No producer in the plan
emits that pair, so I am recording it as an observation rather than a finding.

### The A9 geometry, recomputed by execution

I transcribed the plan's `sanitizeDisplay`, `vis`, `pad`, `rpad`, `clipVisible` and `bar`
verbatim and ran the frame path. Code units diverge sharply from code points, which is exactly
what makes the fix load-bearing, and every case still lands at 78 **code points**:

| Case | code units | code points |
|---|---|---|
| NB-4's own case: `keyId` = 30 astral code points | 108 | **78** |
| ASCII control row | 78 | **78** |
| over-wide ASCII (300 chars) | 78 | **78** |
| over-wide astral (300 emoji) | 153 | **78** |
| astral wrapped in an SGR colour | 118 | **78** |
| filter field, 30 astral code points | 108 | **78** |
| exactly `INNER` astral (75) | 153 | **78** |
| `INNER` + 1 astral (76) | 153 | **78** |
| combining marks, NFC-composed | 78 | **78** |

The code-unit/code-point mismatch is genuinely closed along the whole path, not merely at
`sanitizeDisplay`. `clipVisible` advances by `cp.length` while counting `seen += 1` per code
point, so it now agrees with the `bar` that calls it, and the `[0m` reset it appends is stripped
by `vis` and costs nothing. I could not construct an input that renders short.

---

## New findings

### NC-1 (BLOCKER) — five code blocks in the plan do not parse. The escape corruption the Planner reported is not fixed, and it is in four different files.

**Anchors:** L718; L1867–1868; L1958–1959; L6530 and L6549; L7525–7526.

I extracted all 78 fenced JavaScript blocks and ran `node --check` over each. Eight failed; three
are deliberate fragments (L8760–8764, L8768–8770, L8780–8782 are partial snippets shown for
context, correctly). The other five are real, and they are in the code the plan instructs the
implementer to paste:

**1. `menu/sanitize.mjs`, L718 — the `INVISIBLE` character class.** The class is written with
literal invisible characters rather than `\uXXXX` escapes. Two of them, U+2028 LINE SEPARATOR and
U+2029 PARAGRAPH SEPARATOR, are ECMAScript LineTerminators, and a `RegularExpressionLiteral` may
not contain one. I isolated the cause rather than assuming it: rebuilding the class with only
U+2028 and U+2029 escaped makes it parse, and rebuilding it with none escaped does not. The
decoded class is `[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]`.

This one carries a second hazard, and it is the reason it drives the severity. `sanitize.mjs` is
imported by `style.mjs`, `catalog.mjs` and `denylist.mjs`, so Task A3 — the third task in the
plan — cannot produce a loadable module and nothing downstream of it runs. The obvious repair is
to retype the class, and A3's tests cover U+200B, U+200F, U+202C, U+202D, U+202E, U+2066, U+2069
and U+FEFF one by one (L610–617) but **not U+2028 or U+2029**. A repair that drops the two
characters the implementer cannot see leaves every test green while silently removing the two the
comment directly above singles out as "a newline by another name" — which, in a full-screen frame
writer, is precisely a frame-integrity break. Prose states the property, the test appears to check
the class, the code cannot deliver it.

**2. `test/denylist.test.mjs`, L1867–1868 and L1958–1959 — a missing `]` in each.** Both are
`new Map([["acme", [ … ]])` where three closing brackets are required. I balanced the three
`buildProviders` calls in that block programmatically: the call at L1936–1943 closes cleanly,
and these two each leave one `[` open. The file raises `SyntaxError: Unexpected token ')'` and
none of its tests load — including the MJ-5 hostile-`opus` assertion that guards Task A5.1's
routing-path denylist. The two broken calls are the NB-5 fix and one of the two `testModel`
guards, so both of the round-2 additions to this file are inside the breakage.

**3. Task A16's install test, L6530 and L6549 — `"\n"` collapsed to a literal newline.** Both
read `JSON.stringify(…, null, 2) + "` with the string left open at end of line. `SyntaxError:
Invalid or unexpected token`.

**4. `test/merge.test.mjs`, L7525–7526 — `.replace(/[\]/g, "/")`.** `\]` escapes the bracket, the
character class never closes, and the file raises `SyntaxError: Invalid regular expression:
missing /`. The intent is plainly `/[\\]/g`, normalising Windows separators. This is the
backslash-mangled regex the Planner reported as fixed; it is still present, and it is in
`merge.test.mjs` — the file that exists to gate the round-2 blocker. Its documented Step 2
expected-failure message (a missing `classify` export) is also wrong, because the parse error
fires before module resolution.

On cause, since the assignment asks me to verify causes rather than assert them: this environment
reproduces the mechanism. `cat > file <<'QUOTED'` heredocs in this shell strip one level of
backslash even when the delimiter is quoted — I hit it twice while writing scratch verifiers for
this review, in exactly the shape of the L7525 defect. And when I transcribed L718 verbatim into a
fresh file, it failed identically, which confirms the corruption is in the plan's bytes and not in
my extraction. The pattern is live, so a repair pass applied through the same mechanism will
reintroduce it. Whatever writes these blocks should not be a shell heredoc.

*Fix:* repair the five sites; for L718 use `\uXXXX` escapes rather than literal characters, and
add U+2028 and U+2029 to A3's per-code-point test so the class cannot silently shrink.

### NC-2 (MAJOR) — three tests in `tiers.test.mjs` still assert the retired `string[]` shape, contradicting two tests added beside them.

**Anchors:** L8086, L8107, L8115 (the old shape); L8030–8036 and L8044–8046 (the new); L8218–8219
and L8251 (the implementations).

The implementations are correct. `tier1` maps `Object.entries(p.models)` to `{...meta, model: id}`
and `tier2` maps `kept` to `{model: id}`. Three assertions were not updated with them:

- L8086 `assert.deepEqual(r.providers.get("acme"), ["acme-1", "acme-2"])` — `tier1` returns
  `[{model:"acme-1"},{model:"acme-2"}]`.
- L8107 `assert.deepEqual(out.get("good").models, ["a", "b"])` — `tier2` returns `[{model:"a"},{model:"b"}]`.
- L8115 `assert.deepEqual(out.get("evil").models, ["fine"])` — `tier2` returns `[{model:"fine"}]`.

L8107 and L8115 sit in the same file as L8044–8046, which asserts `Object.keys(m)` is `["model"]`
on `out.get("acme").models[0]`. That is two tests in one file asserting incompatible types for one
field — verbatim the pathology B5's prose (L7403) says was the whole of the round-2 blocker,
surviving in the sibling file that was not given the same treatment. L8078's title, "tier1 parses
a 200 into provider -> model ids", is the stale naming that goes with it.

This differs from the round-2 blocker in one important way: these fail **red**, so B6 cannot reach
`# fail 0` and nothing ships green over a broken pipeline. The risk is the repair direction. An
implementer reading `expected ['a','b'], got [{model:'a'},…]` may fix the producer rather than the
assertion, which reopens NB-1 exactly. The three tests should be corrected to the `Entry` shape,
and B5's `E()`/`ids()` helpers are worth copying into this file for the same reason they were
added to the other one.

Separately, the wire-boundary fixtures are all correct and should not be changed: L887–888, L1415,
L1446 and L1901 are CCR's `getConfig` and the injected relay; L8042, L8101 and L8113 are
`probeProvider`'s listing input. Each is an id string at a genuine boundary, converted on receipt.
L7570 is the deliberate negative test for `writeSnapshot`'s refusal.

### NC-3 (MINOR) — one width assertion in A9 still measures code units, three lines from a comment forbidding it.

**Anchor:** L3428, `assert.equal(strip(l).length, FRAME_W)` in "an over-wide cell clips the row".

Every other width assertion in the task uses `[...strip(l)].length` (L3399, L3410, L3453), and
L3408–3409 states that "using `.length` here would let an astral row pass this test while
rendering short". This one was missed. Its fixture is `"z".repeat(300)`, all ASCII, so units and
points agree at 78 and it passes today. My recomputation gives the number it would produce the
moment the fixture gained an astral character: **153**, not 78. Harmless now, wrong by the task's
own stated rule, and in the one test whose subject is over-wide input.

### NC-5 (MINOR) — tier 3 writes a synthetic provider into the ledger, and it never leaves.

**Anchors:** L8260–8272 (`tier3`); L8428 and L8436 (the call and the merge); L7660 (the
carry-forward rule); L8872 (`writeHealthFromOutcomes`); L7969 (the Interfaces line).

`tier3` returns `new Map([["__verify-cli", {kind: "ok", at, models: []}]])` — a whole-run verdict
under a fabricated provider key — and `refresh/cli.mjs` passes that Map straight into
`mergeSnapshot`. Traced: `before` is `null`, so the shrink guard's `before && before.count > 0` is
skipped, and `mergeProvider(null, …)` mints `{models: [], lastOk: now, consecutiveFails: 0, stale:
false, count: 0}` under the name `__verify-cli`. From then on it is permanent — L7660's rule is
that a provider absent from a run's outcomes is copied forward untouched, so every later tier-1 and
tier-2 run preserves it. It also reaches `health.json`: `writeHealthFromOutcomes` iterates
`Object.entries(snapshot.providers)`, and at tier 3 `keyed` is true, so the phantom is recorded
with `source: "listing"` and a fresh `lastOk`.

The catalogue itself stays clean — `writeSnapshot` iterates an empty `models` array and emits no
rows — so this is not an `Entry`-shape violation, and on the shape question the tier-3 path is
sound. The defect is that a per-run result is being written through a per-provider merge.

Two related observations at the same anchors. `tier3(rows, { confirmed = false } = {})` ignores
`rows` entirely and destructures neither `probe` nor `rpc`, though the Interfaces line at L7969
declares both as options — so the injection points the harness story depends on do not exist. And
because the implementation `spawnSync`s `verify-cli.mjs` at a hard-coded absolute path with `stdio:
"inherit"`, it cannot be exercised in isolation; the only tier-3 test (L8136–8138) asserts the
confirmation refusal and returns before reaching the spawn, so nothing below that line is covered.

*Fix:* have tier 3 return an empty Map and report its verdict through the console and an exit code,
or key its outcome per provider if it is to participate in the merge at all. Either way, drop
`probe` and `rpc` from the Interfaces line or honour them.

---

## The two round-2 findings that are not resolved

### NB-2 — the level-0 literal, executed

I built the level-0 provider-row renderer from L3776–3788 and ran it against the A9 fixture at
L3193–3197. The two lines differ in exactly one character:

```
actual : |> personal.google.free                2   ###### 3          * ok            |
literal: |> personal.google.free                3   ###### 3          * ok            |
                                                ^ index 39
```

Both are 78 columns; `barCol` is 43 and `healthCol` is 63 on the rendered row, so the derived-offset
test at L3339 passes and only the literal fails. That is the three-tier ordering working as
designed for the second round running.

The cause, verified this time rather than inferred. The A9 fixture at L3193 reads `free: 3,
planCount: 0` and carries **two** models. The frozen ASCII mock at L3124 shows the same provider
with **three** models and three free — `3   ▰▰▰▰▰▰ 3` — and the mock is internally coherent, as
are its three sibling rows. The literal was transcribed from the mock's rendered digits rather than
generated from the fixture, so it inherited the mock's model count. `proportionBar` conceals half
of the mismatch: `proportionBar(3, 2, g)` computes `filled = 9` and `Math.min(width, filled)`
saturates it to `"######"`, which is what the mock shows for 3-of-3. The count column has no such
clamp, so it is the only cell that shows the disagreement.

*Fix, either way round:* set the fixture to `free: 1` (it has one `FREE` badge and one `PAID`),
which makes the row coherent and gives count `2`, bar `"###..."` and free `1`; or add a third free
model so the fixture matches the mock, which keeps the literal but requires `META.models` to move
from 3 to 4. The first is smaller.

One note on attribution, offered as a fact rather than a defence. My round-2 text traced this to
"the fixture's own incoherent `free: 3`". The synthesis records that the fixture reads `free: 12,
planCount: 4`. Those are two different fixtures: `free: 12, planCount: 4` is at **L3916, in Task
A10**, and the fixture that feeds the level-0 literal is at **L3193, in Task A9**, reading `free:
3, planCount: 0` — in this snapshot and also in the 08:56 `v2-reviewed` snapshot, so it has not
changed. I am flagging it only because the correction changes which fixture needs editing.

### NB-8 — the `await` guard fails on the file it guards

**Anchors:** L4004 (the assertion); L4269 (the word it matches); L4146–4367 (the `uwpick.mjs`
source block).

`main` was correctly de-asynced at L4232 and `assert.doesNotMatch(src, /export\s+async\s+function\s+main/)`
at L4005 therefore passes. But L4004 adds `assert.doesNotMatch(src, /await/)`, a bare substring
match, and the `uwpick.mjs` source the test reads contains the word at L4269:

```
// The loop is a blocking readSync with no `await` in its body, so the JS stack
```

That is the only occurrence in the block, and it is prose inside the marker comment the guard was
written to protect — so scoping the regex to the region after the marker, which is what my round-2
fix text suggested, would not help either; the comment is below the marker. A10's Step 4 cannot
reach `# fail 0` as written.

*Fix:* match `await` only where it can execute — for instance `doesNotMatch(src.replace(/\/\/.*$/gm, ""), /\bawait\b/)` —
or reword the comment to say "no asynchronous suspension" and keep the bare guard.

---

## One finding I should have caught earlier

### NC-4 (MAJOR) — the catalogue-lock test takes the lock on the live `~/.uw/catalog`, and does not test the behaviour in its own title.

**Anchors:** L7671–7677 (the test); L7806 (`acquireCatalogueLock({ root = CATALOG_DIR } = {})`);
L7296 (`CATALOG_DIR` = `~/.uw/catalog`); L7440–7442 and L7419 (the constraint it breaks).

`acquireCatalogueLock()` is called three times with no argument, so `root` defaults to the live
catalogue directory. The function then runs `fs.mkdirSync(root, {recursive: true})` and
`openSync(LOCK, "wx")` there. The header comment eight lines above the first test says "every test
in this file that touches the store passes an `fs.mkdtempSync` root. **None of them can see
`~/.uw/catalog`**, which is the directory the running session's picker reads", and the task prose
at L7419 states the same as a consequence of Constraint 15. Every other test in the file passes
`{root}`. This one does not, and the claim in the comment is therefore false of the file it
describes.

The practical harm is small but real: if a refresh or a picker holds the lock, the test throws and
fails for an unrelated reason; and because `release()` only unlinks when the pid matches, a test
process killed mid-run leaves a live lock that blocks real refreshes until someone deletes it.

The title promises more than the body delivers. "reclaims a dead owner" is the subtle branch —
`EEXIST`, read the owner, `process.kill(pid, 0)`, unlink, reopen — and the test never writes a
stale lock naming a dead pid, so that branch is untested. So is the corrupt-lock refusal at L7818,
which is the one place the code deliberately fails closed.

This test is byte-identical in the 08:56 `v2-reviewed` snapshot, so it is **not** a regression and
not a product of the round-2 edits. It is pre-existing, and I missed it in rounds 1 and 2.

*Fix:* thread a `mkdtempSync` root through all three calls; add a case that writes a lock file
naming an unused pid and asserts it is reclaimed, and one that writes a corrupt lock and asserts
it is refused.

---

## Confirmed not regressed

Task A5.1's routing-path denylist is intact: `import { admitRemoteModels }` is present at L2065
and L2101, the filter runs before `ranked` is computed, and the rationale for filtering the array
rather than the sort (L2096) is unchanged and correct. Its *implementation* is sound; only its test
file fails to parse (NC-1). BL-2's `%ERRORLEVEL%` propagation, BL-3's `routableSet` grep guard,
and the Q4.7/Q4.8/Q6.x OMC and CCR material are all present and unchanged. B10 carries no
`string[]` assertions. The level-1 exact-row literal I re-executed and it matches the renderer
byte for byte, with the badge at column 60 and `TVR` at 66 — the same result as round 2, now
confirmed by running it rather than by arithmetic.

---

## Minimum set to reach SOUND-WITH-CHANGES

1. **NC-1.** Repair the five non-parsing blocks, and do it with a mechanism that does not eat
   backslashes. Add U+2028 and U+2029 to A3's per-code-point test so the class cannot shrink
   silently during the repair.
2. **NC-2.** Correct L8086, L8107 and L8115 to the `Entry` shape and fix L8078's title. Do not
   change the producers.
3. **NB-2.** Set the A9 fixture to `free: 1`, then regenerate the level-0 literal by running
   `frame()` — count `2`, bar `"###..."`, free `1`.
4. **NB-8.** Make the `await` guard ignore comments, or reword the comment.

NC-3, NC-4 and NC-5 are small and can ride along.

The right general remedy is narrower than any of these. Both round-2 fixes that failed — NC-2 and
NB-8 — failed the same way: the change was reasoned about correctly and never run. The plan's own
instruction at L3319 ("Execute `frame()` once and diff before checking off Step 4") is exactly the
discipline that would have caught NB-2, NC-2, NB-8 and all five parse errors, and it is written
into the plan already. Running every fenced JavaScript block through `node --check` costs seconds
and would have caught NC-1 in full.

# Phase 6 plan — delta re-review (critic, pass 2)

**Artifact:** `C:/Users/osami/.uw/plans/phase6-menu-and-catalogue.md`

**Snapshot reviewed:** sha256 `bae12508bf5719573d68a95fe04896fe46941236bfc5198ef5745af9653cba65`,
8,560 lines — verified at the start of this pass, matching the assignment.

**File drift during review.** The file changed while this review was in progress. At the end
of the pass it was sha256 `a705afa7cf536f8db97981e0dfb2a684be449856ad0213e1ae5f1a16632c3e5d`,
8,967 lines, mtime `2026-09-03 10:13:47 +0300`. Every finding below was re-verified against
the *later* bytes before being written down, and every line anchor cited is from that later
file, so the anchors are usable — but the plan is under concurrent edit and a finding may
have been addressed after 10:13.

---

**Verdict: UNSOUND.** 1 BLOCKER, 3 MAJOR, 5 MINOR new.
Of twenty-six prior findings: **25 RESOLVED, 1 PARTIALLY RESOLVED.**

The revision is a large and genuine improvement. Three of the four original blockers are
closed properly — not annotated, closed — and the two closures I most expected to be
cosmetic (BL-1's routing-path wiring, BL-3's dead-code removal) came back strongest, each
now carrying an executable guard rather than a claim. Prose that used to assert safety
properties now generally either implements them or names the limit.

The failure that remains is the same shape as the original thesis, relocated. Phase B's
`writeSnapshot` was fixed so the refresher writes the file readers open; it now writes that
file in a shape no producer in the plan emits, and the test that proves the fix uses a
fixture shape no producer emits either. The defect moved one layer down and became harder to
see. Phase A carries three mechanical test defects, two of them inside test code added *by*
the BL-4 fix, which cannot pass as written.

---

## Prior findings

| # | Status | Evidence |
|---|---|---|
| BL-1 | RESOLVED | Task A5.1 adds `import { admitRemoteModels }` to `keysync/keysync.mjs` and filters `catalogEntries` and `vp.testModel` before `ranked` is computed (L2034–2037); `keysync/keysync.mjs` is in the Files list. |
| BL-2 | RESOLVED | `:pick` propagates `%ERRORLEVEL%` on both the `UW_PICK_OVERRIDE` and PowerShell branches; passthrough is hard `exit /b 0`. `abort()` truncates then exits `discardExit`. No third path: `UW_PICKER_QUIT_IMMEDIATELY` routes through `quit()` → `abort()`. |
| BL-3 | RESOLVED | The live RPC and `resize` listener are gone; routability is a snapshot field stamped by `refresh/cli.mjs`, and a grep test (L3892) fails on `.then(`, `on("resize")` or `routableSet` reappearing in `uwpick.mjs`. |
| BL-4 | **PARTIALLY RESOLVED** | Geometry half fixed: `INNER = FRAME_W - 3` (L3435) is correct — `bar()` emits `V + INNER + " " + V` = 78 — and the badge is coloured after padding with the `+9` gone (L3681). I recomputed all eight row types below; every one lands at 78. But BL-4's other half was "the exact-frame tests contradict the renderer", and the level-0 literal still does (NB-2), while the new test written to prove the colour fix cannot pass (NB-3). |
| MJ-1 | RESOLVED | `consecutiveFails` is carried through `mergeProvider` and asserted across runs including reset-on-success. |
| MJ-2 | RESOLVED | Two producers in `refresh/health-writer.mjs`: `writeHealthFromProbeFile` folds the existing `key-health-latest.json`; `writeHealthFromOutcomes` is called per refresh from `refresh/cli.mjs`. `refresh/probe.mjs` retires the three ad-hoc scripts. |
| MJ-3 | RESOLVED | All PowerShell writes go through `[IO.File]::WriteAllText(..., (New-Object Text.UTF8Encoding $false))`; `readJsonOr` strips a leading BOM. |
| MJ-4 | RESOLVED | `settings.json.uw-bak` is now read on the restore path, guarded on the recorded `previousCommand` still matching, with an announced value-level fallback; the byte-for-byte claim is scoped to the path that is byte-for-byte. |
| MJ-5 | RESOLVED | The git-log grep is gone. `denylist.test.mjs` imports `buildProviders` from `../keysync/keysync.mjs` and asserts a hostile zero-priced `opus` is absent from `out.providers[].models`, with `qwen3-max` still present. |
| MJ-6 | RESOLVED | The live-corpus assertion moved to `test/corpus-tier.mjs`, a script `node --test` does not collect, run explicitly after B4. |
| MJ-7 | RESOLVED | The bench child now runs the real open path — hide/clear, `framesFor("open")`, per-frame write to a pipe — and the wrapper-inclusive number is explicitly soft. See NB-7 for a residual. |
| MJ-8 | RESOLVED | `priceOf` returns `null` and `inferTier` returns `"unknown"` when no offer's `provider` matches; the no-provider path decides only when exactly one offer is usable. The fallback is blank, not offer 0. |
| MJ-9 | RESOLVED | Order is correct: `ESC_SEQ` → `CTRL` → `INVISIBLE` → `normalize("NFC")` → code-point slice (L728). Strip precedes normalise precedes slice, as required. The fix introduced NB-4 at the `style.mjs` seam. |
| MJ-10 | RESOLVED | Moved to Task A5.1, before A6 and seventeen tasks earlier than B1; the `B1` slot is vacated. My dependency claim was correctly rejected — see the closing paragraph. |
| MJ-11 | RESOLVED | `settings.json` is written by `menu/set-statusline.mjs` (lossless JSON edit) into a tmp file, then `Move-Item -Force`. |
| MN-1 | RESOLVED | Four distinct glyphs in both sets (`dotOk`/`dotWarn`/`dotBad`/`dotStale` = `●◐✖○` / `*$xo`), and the test asserts `new Set(glyphs).size === 4` with colour off. |
| MN-2 | RESOLVED | Health label padded to `W.health` = 8 with the dot in a separate two-column gutter; `"needs $"` (7) fits, with a regression test. |
| MN-3 | RESOLVED | `proportionBar`'s default width is `W.bar` = 6. Level-0 header = 70 columns, provider row = 70 columns — recomputed, they agree. |
| MN-4 | RESOLVED | The Interfaces line declares `cadenceOf`, `healthOf` and `routableOf`. |
| MN-5 | RESOLVED | Every reference says fifteen; the only surviving "twelve" is an unrelated "twelve-line editor". |
| MN-6 | RESOLVED | `CONTRACT.paths` and `statusline.displayPath` are named in A4's Interfaces block with a note explaining why. |
| MN-7 | RESOLVED | The boundary grep covers `.ps1` and `.cmd` with a commented per-file allowlist; `["uwpick.cmd", /(?!)/]` permits no needle at all. |
| MN-8 | RESOLVED | `menu/catalog.mjs` appears only in the Moved table. See NB-6 for the same class reintroduced by two new modules. |
| MN-9 | RESOLVED | `uw doctor` has a `bundled-catalogue` check returning amber with a named fix. |
| MN-10 | RESOLVED | `import * as K from "../keysync/keysync.mjs"` is now static. |
| MN-11 | RESOLVED | Q7.8 and a paragraph in A12 record that output VT on `CONOUT$` is inherited from the host, deliberately not set, with the failure mode named. |

### Frame geometry, recomputed

`INNER` = 75; `bar()` emits `V` + 75 + `" "` + `V` = 78. Column table
`{keyId 30, count 7, bar 6, free 12, health 8, id 34, ctx 6, price 7, badge 6, caps 3}`.

| Row type | Composition | Body | Line |
|---|---|---|---|
| title / footer | `head` + `h`×(78−len−1) + corner | — | 78 |
| filter bar (L0) | 11 + gap 29 + 35 | 75 | 78 |
| level-0 header | 2+30+7+3+18+2+8 | 70 | 78 |
| level-0 row | 2+30+7+3+**6**+1+11+1+1+8 | 70 | 78 |
| level-1 header | 2+34+6+1+7+7+2+6+3 | 68 | 78 |
| model row | 2+34+6+1+7+7+2+**6**+3 | 68 | 78 |
| legend (longest) | 2+55 | 57 | 78 |
| empty state (filter `zzz`) | 2+14+3+1+1+1+33 | 55 | 78 |

Header and row agree at both levels, and the derived-offset test's `barCol` = 43,
`healthCol` = 63 and `badgeCol` = 60 all match the rendered positions. The **level-1 literal
is correct at 78 columns and correct cell by cell** — I checked all thirteen segments. The
level-0 literal is 78 columns but wrong in one cell; see NB-2.

---

## New findings

### NB-1 (BLOCKER) — `writeSnapshot` writes a `models.json` no producer can fill and no reader can use. Its test passes on a fixture the pipeline never emits.

**Anchors:** L7594 (`writeSnapshot`), L7870–7871 (`tier1`), L7894 (`tier2`), L7307–7311 and
L7266 / L7273 (the two contradictory test shapes), L8121–8124 (`refresh/cli.mjs`), L7681
(the `tier1` Interfaces line).

B5's stated defect was that the refresher wrote `index.json` while `resolveCatalogPath`
looked for `models.json`, "so no refresh could ever reach a reader". The fix writes both.
The catalogue half is built like this:

```
for (const m of p?.models ?? []) {
  models.push(p.stale ? { ...m, provider, stale: true, staleSince: p.staleSince }
                      : { ...m, provider });
}
```

This requires `providers[name].models` to be an array of **objects**. Both producers emit an
array of **strings**:

- `tier1` (L7870): `const ids = Object.keys(p?.models ?? {}); if (ids.length) providers.set(name, ids);`
- `tier2` (L7894): `out.set(name, { kind: "ok", models: kept, at })`, where `admitRemoteModels` is documented `@returns {{kept: string[], ...}}`.

Spreading a string yields `{"0":"q","1":"w",…,"provider":"tokenrouter"}`. The emitted
`models.json` is an array of character-index objects with no `model`, `pricing`, `limits` or
`modalities` field. `loadCatalog` groups by `provider` and succeeds; `buildFrom` and
`buildProviders` then call `admitId(e.model)` on `undefined`, get `null`, and drop every
entry. The refresh pipeline is a no-op again, one layer further down than before, and now
silently — the picker keeps rendering B4's copied bundle.

Three things make this a blocker rather than a typo.

**The plan already knows the shape is ambiguous, and accommodates it in exactly one place.**
`refresh/cli.mjs` coerces with `(o.models ?? []).map((m) => m.model ?? m)` (L8123) — an
explicit accommodation of both forms. `writeSnapshot`, five hundred lines earlier, does not.
The ambiguity is handled at the seam that noticed it and fatal at the one that did not.

**The test that proves the fix uses the shape the producers do not emit.** In the same test
file, `mergeProvider`'s tests use `models: ["a", "b"]` (L7266, L7273) while `writeSnapshot`'s
test uses `models: [{ model: "acme-1" }]` (L7307). Two tests in one file assert incompatible
types for one field, and the one that matches production is not the one `writeSnapshot` is
written against. `# fail 0` will be green.

**Even with the shape corrected, the data is not there.** `tier1` discards everything except
the id: `Object.keys(p?.models ?? {})` throws away models.dev's per-model pricing, context
limits and modalities. `priceOf`, `inferTier`, `badgeOf` and the `ctx` column all read
`pricing.offers[].per1MTokens`, `limits.contextTokens` and `modalities.output`. A refreshed
catalogue would therefore carry ids and nothing else — every badge blank or `FREE?`, every
price and context blank — which is strictly worse than the bundled catalogue it replaces.
The Interfaces line for `tier1` says `Map<string, Entry[]>` (L7681); the implementation
returns `Map<string, string[]>`. That one-word disagreement is the whole defect stated in a
line.

B10 will not catch it: it asserts `byProvider.size > 0` (true — grouping is by `provider`,
which survives), and its badge assertion is vacuous over an empty model list. The one
assertion that would fail, `openrouter` having at least one `FREE` model, sits behind an
early return, and B10 exercises the refreshed path at all only if a tier-1 or tier-2 run has
happened first.

*Fix:* decide the type once and state it in `Interfaces`. Carrying full entries is the only
option that keeps the badges working, which means `tier1` must keep models.dev's per-model
object rather than `Object.keys` it; `tier2`'s listing (which genuinely returns ids only)
must merge ids into existing entries rather than replace them; and `mergeProvider`'s tests
must use the chosen shape. Then add one assertion to the B5 test that an entry written into
`models.json` survives `priceOf` and `badgeOf`.

### NB-2 (MAJOR) — A9's level-0 exact-row literal asserts a model count the renderer cannot produce, and its fixture is internally incoherent.

**Anchors:** L3141–3145 (fixture), L3271–3277 (literal), L3663 (`const total = r.models.length`).

The literal asserts `" ".repeat(16) + "3"` in the count column. `total` is `r.models.length`,
and `ROWS[0].models` has two entries. The renderer emits `2`. The test fails as written.

The cause is visible in the fixture: `free: 3` on a row with two models, one badged `FREE`
and one `PAID`. The `3` in the literal was taken from `free`, not from the model count. The
fixture is also wrong on its own terms — a coherent row here is `free: 1` — and correcting it
changes the bar literal too, because `proportionBar(1, 2, g)` is `"###..."`, not `"######"`.
Everything else in the literal is right: I recomputed all thirteen segments and they sum to
78 with correct cell boundaries.

This is the specific thing the assignment asked to be checked — whether the regenerated
literals are right rather than merely regenerated. The level-1 literal is right. This one was
regenerated against a fixture that is itself wrong, so regenerating it from a run would have
produced `2` and quietly preserved the impossible "3 free of 2 models".

*Fix:* `free: 1` in the fixture; count digit `2`; bar `"###..."`.

### NB-3 (MAJOR) — the test added to prove the badge keeps its colour asserts colour on the one row guaranteed to have none.

**Anchors:** L3309–3320 (test), L3156–3160 (`V1`), L3657 and L3694 (selection inversion).

`V1` has `cursor: 0, top: 0` and exactly one item, so `selected` is true and the renderer
emits `bar(g, p.inv(strip(body)))`. `strip` removes every SGR sequence before `p.inv` wraps
the row, so the emitted line contains `\x1b[7m` and `\x1b[0m` and nothing else. The assertion
`assert.match(row, /\x1b\[3[0-9]m *FREE|\x1b\[3[0-9]mFREE/, "the badge must still be
coloured")` cannot match. The width half of the same test passes, because `strip(row)`
removes the inversion too.

This is BL-4's own shape reproduced inside BL-4's fix: a test that appears to check a
property, against code that cannot exhibit it on the fixture supplied. Worth noting that the
underlying render is arguably correct — an inverted row is *meant* to drop its colours — so
the defect is entirely in the fixture choice, and the property the test means to assert is
real and remains untested until the fixture moves off the cursor.

*Fix:* assert against a non-selected row (`cursor: 1` with two items, or find an unselected
model line), and leave the width assertion where it is.

### NB-4 (MAJOR) — the MJ-9 fix made `sanitizeDisplay` count code points while every consumer in `style.mjs` still counts UTF-16 code units, and the fix's own comment claims it protects the invariant it can now break.

**Anchors:** L722–729 (the slice and its comment), L3543 (`pad`), L3557–3572 (`clipVisible`),
L3575–3579 (`bar`).

`sanitizeDisplay` now returns at most `max` **code points**. Its comment says a code-unit
slice "silently breaks the frame-width invariant in style.mjs", implying the code-point slice
protects it. It does not, because `style.mjs` measures in code units throughout:

- `pad` is `sanitizeDisplay(s, n).padEnd(n)`; `padEnd` pads to `.length`, so 30 astral code points (60 units) pad to nothing.
- `bar` computes `visible = strip(clipped).length` — units — and pads `INNER - visible`.
- `clipVisible` counts `seen += 1` per **code point**, so it disagrees with the `bar` that calls it.

A `keyId` of 30 astral code points gives a body of 100 code units and 70 code points.
`clipVisible(body, 75)` sees 70 and returns it unchanged; `bar` then computes
`Math.max(0, 75 − 100)` = 0 padding and emits a 103-unit line. `strip(l).length` is 103, so
the invariant test fails — and in the terminal the frame is short by roughly thirty columns.
The same divergence in `v.filter`, which is user-typed and reaches `left` at L3611, shortens
the meta line without failing any test.

A3's `KNOWN LIMIT` block is honest but covers a different case: East Asian width, where one
code point occupies two columns. This is one code *point* being counted as two, in the
opposite direction, and it is newly introduced by the fix rather than pre-existing.

Reachability is narrow — model ids on the routing path are gated by `admitId`'s
`[A-Za-z0-9._:@/-]` — but `keyId`, `it.target` and `v.filter` are not, and no test feeds
astral data through `frame()`.

*Fix:* make one measure authoritative. A single `const vis = (s) => [...strip(s)].length`
used by `pad`, `rpad`, `bar` and `clipVisible`, with all padding computed from it; and soften
the A3 comment to claim only what it now guarantees.

### NB-5 (MINOR) — the denylist emits a `SECURITY:` warning for every provider that has no `testModel`.

**Anchors:** L2037 (`safeTestModel`), L2013–2015 (the warning).

`admitRemoteModels(reg.provider, [vp.testModel])` is called unconditionally. When
`vp.testModel` is absent, `admitId(undefined)` correctly returns `null` — but the rejection
path pushes `String(raw)` = `"undefined"`, and the function then logs
`SECURITY: provider "X" advertised 1 rejected model name(s): undefined`. Every keysync run
prints one of these per provider without a curated `testModel`, and `keysync.mjs` treats
`testModel` as optional (`if (vp.testModel)`). A security channel that fires on benign
configuration stops being read, which costs more than the line it saves.

*Fix:* `const safeTestModel = vp.testModel ? (admitRemoteModels(...).kept[0] ?? null) : null;`

### NB-6 (MINOR) — two newly created modules are missing from the File Structure table.

**Anchors:** the Created table (≈L233–260); `menu/set-statusline.mjs` (A16 Files line,
≈L5900); `refresh/health-writer.mjs` (B7 Files line, ≈L8190).

Both are created by their tasks and imported by other files, and neither appears in the
Created table, which lists twenty-six other artifacts including the equally new
`refresh/probe.mjs`. This is MN-8's class — the table stops working as a checklist —
reintroduced by the two modules the revision added.

### NB-7 (MINOR) — `sampleWrapper`'s bare `catch` makes a broken wrapper report the best number.

**Anchor:** L4408.

`catch { /* a non-zero exit is the abort path and is expected here */ }` swallows a timeout,
a missing `uwpick.cmd`, and a PowerShell wrapper that fails before it launches node. All of
those are *fast*, so the soft budget prints `ok` most confidently when the chain is most
broken. This matters because `uwpick-run.ps1` opens `CONIN$` to set the console mode, and a
`node --test` harness may have no console — exactly the environment this measurement runs in.

*Fix:* catch and inspect. Treat a non-zero exit equal to `discardExit` as expected; treat a
spawn error, a timeout, or any other exit code as a printed warning naming what happened.

### NB-8 (MINOR) — the "nothing asynchronous below this line" guard bans `.then(` while `main()` is still `async`.

**Anchors:** L4068 (`export async function main()`), L4126–4139 (the marker comment),
L3892–3900 (the grep test).

The comment states that the loop never re-enters the event loop and that nothing
asynchronous may be added. `main` is declared `async` — harmlessly today, since it contains
no `await` — and the grep guard tests only for `.then\s*\(` and `on("resize")`. An `await`
added inside the read loop would compile, would re-enter the event loop, and would pass the
guard that exists to prevent exactly that class of change.

*Fix:* drop `async` from `main` (nothing awaits it), or add a `doesNotMatch(src, /\bawait\b/)`
scoped to the region after the marker.

### NB-9 (MINOR) — the empty-state line loses its own instruction once the filter passes 23 characters.

**Anchor:** L3647.

The line is `2 + 14 + filter + 1 + 1 + 1 + 33` columns, so it exceeds `INNER` = 75 at a filter
length of 24, while `sanitizeDisplay(v.filter, 30)` permits 30. `clipVisible` then keeps the
frame valid — this is not a width bug — but it truncates from the right, and what is on the
right is `backspace to widen, esc to clear`. The user loses the stated way out at the moment
they are most stuck. The frozen ASCII mock (L3090) uses a three-character filter, so the mock
does not reveal it.

*Fix:* clip the filter to 20 in this line, or put the instruction before the quoted query.

---

## Minimum set to reach SOUND-WITH-CHANGES

1. NB-1: fix the `providers[].models` element type end to end — `tier1` keeps entries, `tier2`
   merges ids into them, `writeSnapshot` and both sets of `mergeProvider` tests agree, and one
   assertion proves a written entry survives `priceOf` and `badgeOf`.
2. NB-2 and NB-3: correct the A9 fixture (`free: 1`), the count digit, the bar literal, and
   move the badge-colour assertion onto an unselected row. Without these, A9 Step 4 does not
   reach `# fail 0`, and every later task's gate is built on that number.
3. NB-4: one visible-width function shared by `pad`, `rpad`, `bar` and `clipVisible`.

NB-5 through NB-9 are all one-or-two-line changes and can ride along.

---

## Disagreement

None on the two rejections; both were right, and the second was a real error on my part. On
MJ-10, `buildFrom`'s model loop is authored in A5 and A5.1 rewrites it, so an A3 placement
would have edited a function that does not yet exist — my "depends only on `admitId`" was
derived from the module's imports rather than from its diff, which is the wrong artifact to
read for an ordering claim. On BL-4, my "68 → fits" was correct about fitting and wrong about
the consequence: I checked the body against `INNER` without checking `INNER` against the line
`bar()` actually emits, and had my fix been applied as written, every line would have
rendered at 77 against a test asserting 78 — the same one-column error I was there to catch,
moved from the badge to the frame. The `- 4` → `- 3` correction and the reworked literals are
right, and I verified the whole table above independently rather than by diffing against my
own earlier numbers.

One narrow note, not a finding. The plan's ordering of authority for the frame tests —
invariant first, derived offsets second, literals third and explicitly non-authoritative — is
the correct structure, and it is what made NB-2 findable: the literal disagrees with the
renderer while the invariant and the offsets both hold, which is precisely the failure that
three-tier ordering was designed to localise. The structure worked. It had simply not been run.

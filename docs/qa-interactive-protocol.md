# UW picker — interactive verification protocol

Twenty-seven steps against live Claude Code in a real Windows Terminal (P22 has five
sub-steps, P22a to P22e). Each declares **Do**, **Expected** and **Fail means**. Phase A is not complete until every step
passes.

## Before you start

**This protocol is run by a human, not by an agent.** `tmux` does not run on
native Windows, and under Git Bash it supplies a pty rather than a Windows
console input buffer, so `\\.\CONIN$` and `SetConsoleMode` do not behave as they
do in the environment that ships. `process.stdout.isTTY` is also false under a
piped agent, so any claim an agent made about arrows, echo or console restoration
would be a guess about a different system. An agent may verify a captured
transcript against the expected screens below; it may not produce the transcript.

**The keypress order is load-bearing.** `uwpick.cmd` dispatches on the **first
line** of the buffer Claude Code hands it, so the sentinel must already be in the
chat input when ctrl+g is pressed. Typing `m` into the chat input and *then*
pressing ctrl+g reaches the picker. Pressing ctrl+g on an empty prompt is the
passthrough path and correctly opens your real editor — that is P11, not a
failure of P1.

**Preconditions.** Run `node C:\Users\osami\.uw\menu\doctor.mjs` first. If
`editor-wiring` is not GREEN, stop: no step below can pass, and P1 will fail for
a reason that has nothing to do with the picker. A GREEN `hud-shim` row is only
needed from P15.

**Recording results.** For each step write PASS, or FAIL with the screen you
actually saw. A step whose Expected block mentions a specific string is failed by
a near miss, not just by an error — `0` where `—` is expected is a failure.

---

### P1-sentinel-dispatch

**Do:** in Claude Code, type `m` into the chat input, then press ctrl+g.

**Expected:** the chat pane is replaced by a rounded frame whose title bar reads
`UW > providers` and whose second line ends with `<N> providers · <M> models ·
routable <stamp>` (or `routable —` before any refresh has resolved routability).
The frame draws top-down over about a tenth of a second.

`N` and `M` are whatever the current snapshot holds, not fixed values — the plan
pinned `44` and `1584`, and the snapshot on this machine already reads 45 and
1588, so a pinned number fails this step against working software the first time
a refresh lands. Check them against the snapshot rather than against this
document:

```
node -e "import('./menu/snapshot.mjs').then(m=>{const{snap}=m.loadSnapshot();console.log(snap.rows.length,'providers',snap.rows.reduce((a,r)=>a+(r.models??[]).length,0),'models')})"
```

**Fail means:** the dispatcher did not match the sentinel, or `EDITOR` is not
wired — run `node C:\Users\osami\.uw\menu\doctor.mjs`. If your real editor opened
instead, you pressed ctrl+g on an empty prompt; the sentinel goes in first.

---

### P2-provider-columns

**Do:** read the header row and the rows beneath it.

**Expected:** `key id`, `status`, then (once the full key ids fit and there is room) `oldest probe`, then `models`, `ok` and a `%` column, then (once `oldest probe` is drawn and there is room) `free` and its `%`, then seven raw status columns `empt` `auth` `pay` `rate` `gone` `t/o` `err` in
that order. There is no `health`, `dead`, `needs $`, `skip` or `limit` column. At about 80
columns there is no `oldest probe` or `free` block and long key ids are elided with a visible marker (`~` in ASCII, an em dash in Unicode; 16 characters
show); from about 94 columns every key id is shown WHOLE (the column is sized to the longest full id,
up to 64 characters), `oldest probe` appears after it (about 107 columns for the current ids) and `free` after that (about 117), the other
columns sit right beside it (not pushed to the far edge), and spare width is empty space
at the right. Every column is introduced by a dim vertical rule (`┆` on a Unicode terminal,
`:` on an ASCII one), in the header and in every row, in the same screen columns. There is no
"ids shown without" note in the title, and every row shows its FULL key id including the bucket
(`personal.google.free`, `relay.anthropic.subscription`); typing `personal` matches the rows. The `models`
cell is at most 7 wide (`N` or `N/M`) and never moves a column; `ok` `%` is ok / models while
`[no gone]` is off and ok / (models minus gone) while it is on (`ctrl+x`).

`status` says `alive` (green) when at least one model on the provider answered `ok`; `down`
(yellow) when there are fresh probes, none `ok`, and at least one answered (a refusal for key,
payment or model, an empty reply, a rate limit, a provider error, or a timeout that returned a
first token); `dead` (red) only when every fresh probe got no response at all (a timeout with
nothing back, or a connection failure); and blank when nothing was benched. The word carries
the state on a colourless terminal. `ok` and `free` are a count then a percent with no
parentheses (`236` `50%`; `<1%` for a small non-zero count; `100%` only when every one; `99%`
never `100%` for a partial count); the `ok` count is green and the `free` count blue, and the
percent is green from 70%, yellow from 30% to 69%, red below 30%, dim for `-` (no glyph follows it). `-` is a known zero; blank is unknown.
The other cells are counts, `-` for zero, or blank when the provider has no benchmark data
(a snapshot built without a sweep is all blank, including `status`). Favourites and recents sit
**above** the column header, closed by a thin rule; with none, there is no strip and no rule.
The header's right end reads `P providers | M models | K ok (P%)` (`- ok` when nothing was
benched) and nothing else; the line above the footer reads `id: <full key id>`, then `N plan`
when that provider has plan-covered models, with `routable ...` / `bench ...` dates at its
right end.

**Fail means:** a `0` where `-` or blank belongs is the failure that matters most: it is
the design lying (a blank means "not determined"; a `0` is a claim). A `dead` on a provider
that answered anything, an `alive` on a provider with no `ok` model, a `down` on one with an `ok` model, a
status on a provider nobody benched, a percent with parentheses, a block glyph after a percent, an id elided while the terminal has the width, a status label
touching its neighbour or a cell wider than its label plus a gap, a huge gap between
`key id` and `models`, a pinned row below the column header, a stamp cut in half, or a
ragged frame.

---

### P3-provider-filter

**Do:** type `goo`.

**Expected:** the list narrows to google's credential rows as each character
lands, with no visible redraw flicker and no delay.

**Fail means:** characters buffer until enter (the console mode was not set), or
arrows print `^[[A` (the same cause).

---

### P4-filter-by-model-name

**Do:** backspace to clear, then type `opus`.

**Expected:** the list narrows to providers that *serve* a model matching `opus`,
including `relay.anthropic.subscription`.

**Fail means:** an empty list — the level-1 filter is not searching member model
ids, which is what makes two levels tolerable.

---

### P5-descend

**Do:** clear the filter, arrow to `personal.openrouter.free`, press enter.

**Expected:** the title bar becomes `UW > personal.openrouter.free > models`, the
list slides in from the right, and it shows models rather than providers.

**Fail means:** nothing happens on enter.

---

### P6-model-columns

**Do:** read the header and rows.

**Expected:** `model`, `stat`, then (from about 99 columns) `probed`, `ttft`, then (as width allows) `total`, `tok/s`, then
`ctx`, `$in`, `$out`, `badge`, `modality`, `TVR` (and later `output`); there is no `limit` column;
context values render
as `163k` or `1M`; prices show two decimals; badges are only ever `FREE`, `FREE?`,
`PLAN`, `PAID` or blank; caps render as three characters drawn from `T`, `V`, `R`
and `-`; models CCR cannot resolve are visibly dimmer than the rest.

A route whose last fresh probe said payment is required never shows `FREE?` (its badge is
blank; `?` explains it). On a wide terminal a `gone` route that has a working sibling in the
same provider shows `= <sibling> (works)` in its output cell and `id: <id>  = <sibling>` on
the id line; enter on that row still selects the row itself.

**Fail means:** any badge outside the five-value set, a `FREE?` on a route the bench says needs
money, an alias that points at a sibling that does not answer, enter selecting the sibling,
or a price with no decimals.

---

### P7-select-writes-chat-input

**Do:** arrow to a routable model and press enter.

**Expected:** the picker clears, Claude Code returns, and the chat input contains
exactly `/model openrouter/<the model you chose>` with the cursor at the end.
Press enter and the status footer shows the new model.

**Fail means:** an empty chat input — the picker exited non-zero, so Claude Code
discarded the file.

**Why this step carries extra weight:** it is the only step that exercises the
*accept* half of the handoff contract, that exit 0 makes the file's contents the
chat input. `cc-contract.mjs` asserts that against the running Claude Code
version, and until this step passes on the current version the claim is carried
on the previous one. `uw doctor`'s `handoff-contract` row stays amber until a
selection actually lands.

---

### P8-esc-ladder

**Do:** reopen the picker, descend into a provider, type `x`, then press esc four
times.

**Expected:** the first esc clears the model filter and stays at the model level;
the second returns to the provider list; the third does nothing visible if the
provider filter is already empty, otherwise clears it; the last esc exits with the
chat input unchanged from before the picker opened.

**Fail means:** the first esc exits — the ladder is inverted, and every accidental
esc loses the user's place.

---

### P9-tab-flat-scope

**Do:** reopen, press tab, type `qwen3-max`.

**Expected:** the header shows `provider/model` and rows show full
`provider/model` strings from every provider at once. Press esc: the scope returns
to the tree at the provider level.

**Fail means:** tab inserts a literal tab into the filter.

---

### P10-ctrl-c

**Do:** reopen and press ctrl+c.

**Expected:** the picker exits, Claude Code returns, the chat input is unchanged,
and typing in the terminal echoes normally.

**Fail means:** no echo — the console mode was not restored, and the shell is now
unusable.

---

### P11-passthrough-editor

**Do:** put `hello world` in the chat input, then press ctrl+g.

**Expected:** `%UW_REAL_EDITOR%` opens with `hello world` in it; save and close;
the chat input holds whatever the editor left.

**Fail means:** the picker opened, so the sentinel comparison is too loose.

**Note:** pressing ctrl+g on an *empty* chat input takes this same path, because
an empty buffer has no sentinel on its first line. That is correct behaviour, not
a defect.

---

### P11a-esc-leaves-the-chat-input-empty

**Do:** type `m` into the chat input, press ctrl+g, then press Esc at the provider
level (not inside a filter).

**Expected:** the picker closes and the chat input is **empty**.

**Fail means:** the chat input contains the literal `m`, which is the BL-2 defect
— the picker exited 0 with the sentinel still in the buffer, or `uwpick.cmd`
replaced a non-zero exit with 0. Check `exit /b %ERRORLEVEL%` in the `:pick`
branch and the truncation in `finish`/`abort`.

---

### P11b-ctrl-c-leaves-the-chat-input-empty

**Do:** the same as P11a, but press ctrl+c instead of Esc.

**Expected:** identical to P11a — the picker closes and the chat input is empty.

**Fail means:** the same as P11a. This is a separate step because ctrl+c reaches
the picker as byte 3 through a deliberately unset `ENABLE_PROCESSED_INPUT`, on a
different code path from Esc, so one can pass while the other fails.

---

### P11c-missing-snapshot-leaves-the-chat-input-empty

**Do:** rename `C:\Users\osami\.uw\catalog\snapshot.json` aside, type `m` into the
chat input, press ctrl+g, then restore the file.

```powershell
Rename-Item C:\Users\osami\.uw\catalog\snapshot.json snapshot.json.uwtest
#   ... type m, press ctrl+g, read the line, then:
Rename-Item C:\Users\osami\.uw\catalog\snapshot.json.uwtest snapshot.json
```

**Expected:** one line naming the missing file and the command that rebuilds it,
and an **empty** chat input. Verbatim, with the real path:

```
uwpick: no catalogue snapshot at C:\Users\osami\.uw\catalog\snapshot.json — run: node C:/Users/osami/.uw/menu/snapshot.mjs --build
```

This step needs no keystrokes: the picker fails and exits on its own, so it is
unaffected by anything to do with console input.

An earlier version of this step expected the line to name `uw catalog refresh`.
It does not, and no such command exists here -- that name came from the plan
rather than from the code, and an operator looking for it would have failed a
step that passes.

**Fail means:** a stack trace, a hung picker, or the literal `m` left in the chat
input. This is Q2.1's stated behaviour and the failure most likely to be met by a
user who has never run a refresh.

---

### P12-console-restored

**Do:** after every step above, in the same terminal, run
`powershell -NoProfile -Command "Write-Host 'echo test'"` and type a few
characters at the shell prompt.

**Expected:** characters echo and the command runs.

**Fail means:** the restore in the wrapper's `finally` block did not run; capture
`C:\Users\osami\.uw\state\conmode.json` after a `-Diagnose` run and compare
`saved` with `restored`.

---

### P13-motion

**Do:** reopen the picker and watch the four transitions in order: the frame
drawing itself top-down on open, the model list arriving from the right on enter,
the same in reverse on esc, and the chosen row flashing twice before the frame
collapses to a single confirmation line. That line is, with the real glyphs:

```
✔ switched → openrouter/auto
```

(`OK switched -> openrouter/auto` on a terminal without unicode.) Then hold the
down arrow for two seconds. Then close, set the kill switch, and reopen.

Each transition is three frames at `FRAME_MS` = 30 ms, so 90 ms per transition is
the design budget -- "well under a fifth of a second" below is that, measured.

The kill switch is an environment variable, and the syntax differs by shell.
`set UW_PICKER_MOTION=0` is cmd.exe; in PowerShell `set` is an alias for
`Set-Variable`, so that line sets a PowerShell variable the picker never reads
and the step silently passes for the wrong reason. Use:

```powershell
$env:UW_PICKER_MOTION = "0"     # PowerShell
set UW_PICKER_MOTION=0          # cmd.exe only
```

**Expected:** each transition completes in well under a fifth of a second, and the
held arrow moves the cursor at full speed with no lag, because motion never delays
the next key (Q7.3). With `UW_PICKER_MOTION=0` every transition is gone and the
frames appear instantly.

**Fail means:** a visible pause before the cursor responds to a key, which means a
transition is running where it should have been skipped — or motion still running
with the kill switch set, which makes the switch a lie.

**Why it is only verified here:** three synchronous frames leave nothing for a
test harness to sample that is not our own mock.

---

### P14-legend-and-empty-state

**Do:** press `?`, read the legend, press any key to close it; then type `zzzz`.

**Expected:** the legend replaces the rows and is laid out as four sections, each opened by a
heading rule (KEYS, PROVIDER LIST, MODEL LIST, PROBES) with an aligned `term  meaning` list under it;
the terms are drawn in the colours they have in the picker (alive/down/dead, the modality words,
the probe statuses, the % bands). It lists the keys including ctrl+f and
esc, scrolls with up/down (the footer says "N-M of T"), and every line fits the frame; the key that closes it does nothing else, so pressing esc to close does not
exit the picker; the filter still reads what it read before. With `zzzz` typed,
one line reads, in this order:

```
  backspace to widen, esc to clear — no match for "zzzz"
```

and the help line is still visible at the bottom.

The instruction comes BEFORE the echoed query, and that is not cosmetic. The line
grows with the filter and `bar` clips from the right, so with the query first a
long filter pushes "backspace to widen, esc to clear" off the end -- the user
loses the stated way out at the moment they are most stuck. Earlier drafts of
this step quoted the reversed order, which fails a passing step.

**Fail means:** an empty pane with no explanation, or esc closing the legend and
quitting in one press.

---

### P14a-omc-survives-uninstall

**Do:** with the shim installed, edit `C:\Users\osami\.claude\settings.json` by
hand to add a harmless key (or run any OMC command that writes it), then run
`powershell -File C:\Users\osami\.uw\menu\install.ps1 -Hud -HudUninstall`.

**Expected:** the shim is removed, the added key is **still there**, and the output
says the restore was a value edit rather than byte-for-byte.

**Fail means:** the added key is gone — the whole-file backup was copied over a
file someone else had written, which is the OMC-regression class Q4.8 exists to
prevent.

---

### P14b-uninstall-refuses-a-foreign-command

**Do:** with the shim installed, set `statusLine.command` by hand to anything that
does not mention `hud-shim.mjs` (simulating an OMC setup run), then run
`powershell -File C:\Users\osami\.uw\menu\install.ps1 -Hud -HudUninstall`.

**Expected:** output naming the foreign command, the command left exactly as it
was, and `C:\Users\osami\.uw\state\hud-install.json` removed.

**Fail means:** UW wrote its recorded `previousCommand` over the newer value.

---

### P15-statusline-footer

**Do:** note the model name and the "context left" percentage in the OMC footer,
switch to a model whose context window is not 200k, and look again. Record the
number. Then run `powershell -File C:\Users\osami\.uw\menu\install.ps1 -Hud`,
start a new session, and check again. Finally run the same command with
`-HudUninstall` and confirm the footer still renders.

**Expected:** the footer names the model you selected, with no OMC change (Q6.1).
Without the shim, the context percentage is computed against 200000 and will be
wrong for that model. With the shim installed, it is computed against the
catalogue's real limit. After uninstall, the footer still renders.

**Fail means:** a blank or error-filled footer at any point, which is the one
outcome the shim is built to make impossible. Capture the wrapped command from
`C:\Users\osami\.uw\state\hud-install.json` and run it by hand with a sample
payload on stdin.

**A blank footer has been seen once, and it was not the shim.** `install.ps1`
passed the wrapped command as an argument to a native command; PowerShell 5.1
strips embedded quotes from those, so the node path lost its quoting, the
POSIX-ish shell Claude Code runs the statusline through ate the unguarded
backslashes, and the child failed silently. If this step fails, read
`statusLine.command` out of `settings.json` and check its quotes before
suspecting `hud-shim.mjs`.

---

### P16-bench-view

**Do:** open any provider (or press tab for flat scope). Look at the header and
rows, then resize the terminal to about 80, about 100 and about 130 columns. Press
`ctrl+b` (nothing should happen). Press `ctrl+o`, then `ctrl+l`, then each again.
Press `?` and read the MODEL LIST and PROBES sections.

**Expected:** there is no toggle: one view shows the catalogue columns (`ctx`,
`$in`, `$out`, `badge`, `modality`, `TVR`) **and** the measured ones (`stat`, `ttft`,
`total`, `tok/s`, `output`) together, in that reading order (id, stat, ttft,
total, tok/s, ctx, $in, $out, badge, modality, TVR, output), each column introduced by a
dim vertical rule and the id column only as wide as the longest id (the columns sit
beside it, spare width is empty space at the right). At about 80 columns you see
everything up to `TVR` except `total`, `tok/s` and `output` (ids elided in the middle past
22 characters); wider terminals add `total`, `tok/s` and finally `output`, in that
order, and from about 103 columns every column shows. `modality` is present at every width. It
reads one of `chat`, `chat?`, `image`, `audio`, `video`, `embed`, `rank`, `mod`, `stt`,
`ocr`, `live`, `other` or `?` (unknown), each known word in its OWN colour (twelve distinct
colours; `?` dim), left-aligned under the header `modality`, and a route that no evidence describes reads `?`,
never `chat`; a route the picker already dims as not-chat is never labelled `chat`. The frame is never
wider than the terminal, down to an 80-column terminal: the frame has a **78-column floor**, so on a terminal
narrower than 80 columns it is wider than the terminal and wraps (80 columns is the supported minimum). The header's right end reads `N of M | K ok (P%)`
(flat: `N of M models | K ok (P%)`; `- ok` when nothing was benched) and carries no
dates: `routable`, `benched` and `discovered` sit at the right end of the `id:` line,
whole or dropped, never cut. Under it a `reply:` line shows the selected row's full stored
reply (`~` marks reasoning text; `skipped: <reason>` for a skip; blank when unbenched),
clipped with an ellipsis only at the frame edge; it changes no frame height. The output
column uses all the width there is (up to a 260-column frame). `ctrl+o` adds a
`[ok]` chip and keeps only models whose last benchmark was `ok`; `ctrl+l` adds
`[1M+]` and keeps ctx >= 1M or `[1m]`-tagged models; both together AND with each
other and with typed text, `N of M` follows them, the cursor returns to the top, and
an empty result says which toggles are on (and `no benchmark data yet` for ok-only
without a bench file). Benched rows show a coloured status and timings, unbenched
rows are **blank, not zero**, `empt` rows show no timings. `ctrl+b`, `ctrl+o` and
`ctrl+l` do nothing at the provider list, and never type a character into the
filter. `b` typed as a letter still filters.

Column rules are dim, differ from the frame's own line, and appear in the header and
every row at the same columns; pinned rows, the `... N more` line, the withheld row
and the empty state carry none, and a selected row is inverted across the whole row.

The `id:` line (above the `reply:` line at a model list) reads `id: <full id>` for the selected row (level 1 the
model id, flat `provider/model`, the provider list the full key id), is blank on a row that cannot be selected, and is clipped from the left
with an ellipsis only when longer than the frame. Long ids in the list elide keeping the
part that differs (versions and suffixes stay visible) and CJK or emoji in an id or
preview show as `?` without moving any column. `ctrl+r` on a provider with withheld
models shows the whole withheld id where the terminal allows.

Header stamps end in `Z` (UTC). A model row whose bench record is old still draws its
measured cells (there is no age cutoff; the yellow outdated line says when to re-sweep). On a terminal whose font lacks `┆`, `UW_PICKER_COLSEP=ascii`
(or `latin`) swaps the rule without moving any column.

A row whose stream was cut for ignoring `max_tokens` draws a blank `total`, a `~`-prefixed `tok/s`
and a `reply:` line starting `[cut]`; an ok row with a stream error after the first token has a
`reply:` line starting `[stream error]`.

**Fail means:** a 30-day-old status missing from a row, a cut row showing a `total`, an `ok` `%` whose denominator disagrees with the `[no gone]` chip (over all models when off, minus gone when on), two rows drawing the same id cell
when the width allows better, a
row wider than the frame after a non-Latin id, a header `K ok` that disagrees with the
`ctrl+o` list length, a ragged or wrapped frame at any width, columns touching, a big gap
between the id and the next column, zeros on unbenched rows, a `modality` that says `chat` for an image, audio or embedding model or a guessed value where `?` belongs, a `limit` column, a chip missing while a
filter is on, an `ok` figure showing `0 ok` for no data, a `reply:` line that changes the frame height or shows escape characters, a preview that shows escape
characters or garbles the frame, or a control key appearing in the filter text.

### P17-hide-gone

**Do:** at the provider list note the `ok` `%` of a provider whose `gone` count is above zero and the header
`K ok (P%)`. Press `ctrl+x`. Then open that provider (enter), press `ctrl+o`, `ctrl+x` again, go back with esc,
and press tab for flat scope and `ctrl+x` once more. Move the cursor down several rows before each press.

**Expected:** by default nothing is hidden and the `ok` `%` is ok / models. At the provider list `ctrl+x`
adds a `[no gone]` chip beside the typed filter, changes that provider's `%` and the header figure to
ok / (models minus gone), hides NO provider row, leaves the cursor where it was, and does not change the `ok`
count, `models`, the `gone` column or the `free` `%`. Opening a provider keeps the chip on; on the model list the
same key removes every row whose fresh probe status is `gone` (rows with no fresh record stay), changes
`N of M` to the filtered count, shows the header `K ok (P%)` over models minus gone, and puts the cursor on
the first visible row; the footer reads `[^x]gone`. With `ctrl+o` on as well the header shows `[ok] [no gone]`
and the list is the intersection. Pressing `ctrl+x` again shows every row, restores the original `%` and
removes the chip, at whichever level you are on. If every row is gone the list says `filtered by gone routes
hidden` and how to turn it off. The frame keeps its width at every terminal width.

**Fail means:** a gone row still listed while the chip is on, a row with no record hidden, a provider row
disappearing at the provider list, the `%` not following the chip, the cursor on a row that is not visible or
a blank list with rows behind it, a ragged or wider frame with the chip, or a control byte appearing in the
filter text.

### P18-free-only

**Do:** open a provider that has `FREE`, `FREE?` and `PAID` models, or press tab for flat scope. Press `ctrl+e`,
then `ctrl+o`, then `ctrl+x`, then `ctrl+e` again. Press `ctrl+e` at the provider list. Turn all four toggles
on at once and read the top line at about 80 columns.

**Expected:** `ctrl+e` adds a `[free]` chip and keeps only models whose badge column reads `FREE` or `FREE?`
(a row with a blank badge, including a `FREE?` whose probe said payment is required, is out); `N of M`
follows; the cursor returns to the top; the footer reads `[^e]free`. It combines with the other chips as an
intersection. Pressing it again restores the list. At the provider list it does nothing. With all four chips on
at 80 columns the top line stays inside the frame, the chips shorten (`[1M]`, `[-gone]`) rather than the counts
being clipped, and an empty result says `filtered by FREE / FREE? only` and names `ctrl+e` as the way out.

**Fail means:** a `PAID` or blank-badge row listed while the chip is on, the counts clipped by the chips, a
ragged frame, the key doing anything at the provider list, or a control byte appearing in the filter text.

### P19-outdated-notice

**Do:** with a `bench.json` in which MORE THAN HALF of the records are more than 7 days old (or edit a
copy: set most `a` back 8 days), open the picker. Look above the footer at the provider list, open
a provider, press tab for flat scope, then resize to about 80, 100 and 134 columns. Repeat with every record
newer than 7 days, with exactly half the records older (no line) and one more than half (the line), and with no
`bench.json` at all. With `ctrl+x` on, read the top-right header total.

**Expected:** at every level a yellow line reads `Model Status might be outdated! Last time the list was fully
updated was YYYY-MM-DD, run node refresh/bench-cli.mjs --live to update your list fully` right-aligned on the
last content line above the footer, YYYY-MM-DD being the date of the OLDEST record (UTC); on narrower frames it
shortens to `Status may be outdated (full update YYYY-MM-DD): node refresh/bench-cli.mjs --live` and then to
`Outdated since YYYY-MM-DD: node refresh/bench-cli.mjs --live`, always with the command whole and never wider
than the frame. Old rows keep their cells and counts (nothing is hidden for being old). With half or fewer of the records
older than 7 days, and with no bench data, the line is absent (the no-data case still shows `benched -`).
The list is one row shorter while the line shows and no frame is taller than the terminal. While `[no gone]` is
on, the provider-list header reads `P providers · M models · K ok (P%)` with M = all models minus gone and P =
K / that M; the provider rows' `models` and `gone` columns do not change.

**Fail means:** a notice on fresh data or with no data, the notice quoting the newest record's date, the command
clipped, colour codes leaking on a colourless terminal, a frame taller than the terminal, an old record drawn
blank, or the header total ignoring the `[no gone]` chip.

### P20-oldest-probe

**Do:** at about 134 columns read the provider list's `oldest probe` column; give it a snapshot whose providers
have records of different ages (a re-probe of one provider's models, or edit the `benchAgeHist` of a copy), then
open a provider and go back (the file's histograms replace the snapshot's). Resize down to about 106, 100 and 80
columns and up again; run once with `TERM=dumb` (no colour; the picker does not read `NO_COLOR`, and `TERM=dumb` also switches it to ASCII).

**Expected:** between `status` and `models` a 12-wide column headed `oldest probe` (lowercase, whole) shows the
age of each provider's OLDEST probe record, right-aligned: `45m`, `5h`, `3d`, `12d`, `40d`; `-` for a provider
with no records, blank when there is no bench data. A provider that has one 30-day-old record and many fresh ones
reads `30d`, not the fresh age. Colours: under 2 days green, under 4 yellow, under 7 orange, 7 days or more red;
with colour off the text alone. It is absent below about 107 columns (for the current ids) and `free` goes first
as the terminal narrows: no `free` below about 117 columns, no `oldest probe` below about 107, the key id whole
before either. Header and rows line up at every width and the ages do not change while the picker stays open.

**Fail means:** a header other than `oldest probe`, an age of the newest record instead of the oldest, a wrong colour at 2d, 4d or 7d,
a ragged frame, or `free` shown without `oldest probe`.

### P21-model-probed

**Do:** open a provider whose models were probed at different times (re-probe one model with `--only` first, so
one row is minutes old and others days old, and leave one never probed) at about 134 columns, then narrow the
terminal through 110, 103, 100, 99 and 80 columns, then widen it again; run once with `TERM=dumb`.

**Expected:** right after `stat` a 6-wide `probed` column shows how long ago each model's own record was
written: `<1m`, `45m`, `5h`, `3d`, `40d`, right-aligned, blank for the never-probed model. Colours: under 2 days
green, under 4 yellow, under 7 orange, 7 days or more red; with `TERM=dumb` the text alone. From 103 columns EVERY
other column is still there (`total`, `tok/s`, `ctx`, `$in`, `$out`, `badge`, `modality`, `TVR`) and `output` is
shortened (a sliver of 3 characters at 103, wider as the terminal widens; its header may read `out`, and while it is that narrow a `gone` route's `= sibling (works)` hint and a skipped row's text show blank, not a fragment) rather than any
of them being dropped. Below 103 the `output` column goes first, then `probed` (below about 99 columns), then `tok/s`,
then `total`; at 78 to 80 columns none of the four is drawn. Header and rows line up at every width and no frame is
wider than the terminal.

**Fail means:** any older column missing at 103 columns or wider, the id column narrower than 22 characters, an age
that differs from the record's real age by more than a minute, a wrong colour at 2d, 4d or 7d, a ragged frame, or
`probed` drawn for a model with no record.

### P22-live-status

**Do:** with a recorder-written `state/observed.json` in place (run `node refresh/observe-cli.mjs --catchup` after some real use, or use the
hand-made data of P22b), open the picker. Look at the provider list header and the `id:` line; open a provider whose model had a real success or
failure; select that model and read `stat`, `probed` and `reply:`; press `esc` twice to leave the picker. Then run `node refresh/observe-cli.mjs --off`,
open the picker again and repeat; run `node refresh/observe-cli.mjs --on` and open it once more. Also run `node refresh/observe-cli.mjs --status`.

**Expected:** a live-observed model shows its `stat` in UPPERCASE (`OK`, `RATE`, ...) in the same width; `reply:` starts with `[live HH:MMZ]` (an ok says
"answered HTTP 200 in ... ; no reply text is kept for real requests", a failure quotes the provider's sentence); after a confirmation probe the stat is
lowercase again and `reply:` starts with `[live+probe HH:MMZ]`. The header ok reads `N ok (n live) (P%)` only while some ok are live, and the `id:` line
ends with `live HH:MMZ`. The provider list counts and the model list agree. `oldest probe` and the outdated line do not change because of live results, and
the `probed` cell of a live row shows the age of its live observation. A broken feed shows one dim yellow line above the footer. With `state/observe.off`
present none of this appears and nothing is spawned; removing it brings it back at the next open. `--status` prints `enabled` or `DISABLED (remove observe.off
or run --on)`, the time of the last run, the feed, the watermark and the overlay's record count. The picker opens at the same speed with or without an overlay.

**Fail means:** a live result drawn as a probe (lowercase, no lead) or the reverse, a stat wider than 4 columns, a `live` stamp or `(n live)` with the switch
off or with no live records, `oldest probe` or the outdated line moving because of a live result, the provider list and the model list disagreeing about
the counts, a frame taller than the terminal, or a picker that hangs or shows an error when `observed.json` is missing, torn or locked.

The sub-steps below cover what P22 cannot reach with real traffic. They are part of P22: it passes only when all of them pass. They touch real state
files, so each says what to back up and how to put it back. Every command runs from the repository root (`C:\Users\osami\.uw`) in PowerShell.

#### P22a-tag-check

**Do:** run `node refresh/spike-client-tag.mjs --only openrouter/laguna-s-2.1:free` (a dry run: it prints what it would do and sends nothing), then
`node refresh/spike-client-tag.mjs --live --only openrouter/laguna-s-2.1:free` (ONE real request to a free row, so it costs nothing) and read its last
line and its exit code (`$LASTEXITCODE`).

**Expected:** the dry run says it would send ONE probe carrying the header `x-ccr-client: uw-probe` and ends `no request was made`. The live run ends with
`TAG CONFIRMED: client = uw-probe` and exit code 0: the router recorded the probe's usage row with the client `uw-probe`, which is how the recorder tells UW's
own probes from real use.

**Fail means:** `TAG NOT RECORDED (observed client: X)` (exit 3): the router does not record the header, every sweep probe would look like real use, and the
feed must stay off (`node refresh/observe-cli.mjs --off`) until that is fixed. `INCONCLUSIVE` (exit 4): no usage row appeared in time; run it again. Exit 1 is a
refusal (the row is not in the snapshot, or costs more than $0.01); exit 2 is bad arguments.

#### P22b-hand-made-usage-log

Real traffic rarely produces a 429 followed by a 200 on demand, so this step builds a small usage database of its own and points the recorder at it with
`UW_CCR_DATA_DIR`. It uses the real `state/` files, so back them up first. The picker starts no catch-up of its own here (`UW_OBSERVE_NO_SPAWN=1`); you run each
one by hand.

Save this as `%TEMP%\make-usage.mjs`. It adds one row to `<dir>\usage.sqlite`, shaped like the router's usage table:

```js
// Usage: node make-usage.mjs <dir> <429|200> <provider> <model id>
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [dir, kind, provider, model] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, "usage.sqlite"));
db.exec(`create table if not exists usage_events (
  id integer primary key autoincrement, created_at text, request_id text, client text, provider text,
  model text, status_code integer, duration_ms integer, output_tokens integer)`);
db.exec(`create table if not exists request_logs (
  request_id text, response_body_text text, response_body_size_bytes integer, error text, gateway_error text)`);
const now = new Date().toISOString();
const rid = `qa-${kind}-${Date.now()}`;
if (kind === "429") {
  const body = JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day", code: 429 } });
  db.prepare("insert into request_logs values (?, ?, ?, '', '')").run(rid, body, body.length);
}
db.prepare("insert into usage_events (created_at, request_id, client, provider, model, status_code, duration_ms, output_tokens) values (?, ?, 'Profile: Claude Code', ?, ?, ?, 300, ?)")
  .run(now, rid, provider, model, Number(kind), kind === "200" ? 12 : 0);
db.close();
console.log(`added a ${kind} row for ${provider}/${model}`);
```

**Do:** in the PowerShell window you will start Claude Code from, pick a FREE row that has a probe record (the example uses `openrouter/laguna-s-2.1:free`;
the gateway must be running for the confirmation) and run:

```powershell
$env:UW_CCR_DATA_DIR = "$env:TEMP\uw-qa-data"      # the recorder reads the usage log from here instead of the router's
$env:UW_OBSERVE_NO_SPAWN = "1"                     # the picker starts no catch-up of its own
Copy-Item state\observed.json "$env:TEMP\observed.json.qa-backup" -ErrorAction SilentlyContinue
Copy-Item state\observed.run  "$env:TEMP\observed.run.qa-backup"  -ErrorAction SilentlyContinue
node --no-warnings "$env:TEMP\make-usage.mjs" $env:UW_CCR_DATA_DIR 429 openrouter "laguna-s-2.1:free"
node --no-warnings refresh/observe-cli.mjs --catchup --backfill-days 1
```

The catch-up should print `wrote 1 record(s) {"rate":1}` (its watermark is re-initialised because the hand-made log is a different database). Start Claude Code
from this window, open the picker (`m`, then `ctrl+g`), open `personal.openrouter.free` and select `laguna-s-2.1:free`. Leave the picker (`esc` twice). Then add the
200 a little later, so its time is newer, and catch up again:

```powershell
node --no-warnings "$env:TEMP\make-usage.mjs" $env:UW_CCR_DATA_DIR 200 openrouter "laguna-s-2.1:free"
node --no-warnings refresh/observe-cli.mjs --catchup
```

Wait about 10 seconds for the confirmation probe, open the picker and select the same row again.

**Expected:** after the 429, `stat` reads `RATE` (uppercase, 4 columns), `reply:` reads `[live HH:MMZ] Rate limit exceeded: free-models-per-day`, and the `id:` line ends with
`live HH:MMZ`; the header has no `(n live)` because there is no live `ok` yet. After the 200, the second catch-up prints `wrote 1 record(s) {"ok":1}` and
`confirmation probes: requested 1`. For the few seconds until the probe returns the row reads `OK` with `[live HH:MMZ] worked live; confirming...` and the header reads
`... ok (1 live) ...` (you see this only if you open the picker inside that window). Once the probe has answered, `stat` reads `ok` in lowercase and `reply:` reads
`[live+probe HH:MMZ]` followed by a real reply to "Say hello in 5 words.": it is now a probe measurement, so `(n live)` no longer counts it. If the gateway is down the row stays
`OK` with `[live HH:MMZ] answered HTTP 200 in 0.3 s; no reply text is kept for real requests` after 2 minutes.

**Put it back:**

```powershell
Remove-Item Env:UW_CCR_DATA_DIR, Env:UW_OBSERVE_NO_SPAWN
Copy-Item "$env:TEMP\observed.json.qa-backup" state\observed.json -Force    # if there was no backup, run instead: node refresh/observe-cli.mjs --reset
Copy-Item "$env:TEMP\observed.run.qa-backup" state\observed.run -Force
```

Restoring the backup also removes this test's confirmation reservation, which would otherwise hold that row for 6 hours.

**Fail means:** an uppercase stat wider than 4 columns; no `RATE` after the first catch-up (read `--status` and the catch-up's output); `OK` where the probe should have
overruled it; `[live+probe` without a real reply; no probe request at all with the gateway up (add a fresh 429 and 200 pair and run `--catchup --dry`, then read
`not requested by reason`); or any change to `state/bench.json` (its modified time must not move).

#### P22c-schema-change

**Do:** with the environment of P22b still set, rename a column in the hand-made log and catch up:

```powershell
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.env.UW_CCR_DATA_DIR+'/usage.sqlite'); d.exec('alter table usage_events rename column status_code to status_code_old'); d.close()"
node --no-warnings refresh/observe-cli.mjs --catchup
node refresh/observe-cli.mjs --status
```

Open the picker, read the provider list, then open a provider.

**Expected:** the catch-up prints `feed unavailable:schema` and `--status` prints `feed: unavailable:schema` and, on the next line, `usage_events columns missing: status_code`. The picker opens normally, keeps the last live records on screen,
shows one dim yellow line above the footer, `live feed unavailable (schema changed)` (the outdated notice takes that line's place when both apply), and every probe column
is unchanged. The catch-up prints no "messages from ..." line while the feed is unavailable. `bench.json` is not written. Put it back as in P22b; the restore also brings back the healthy
`feed`.

**Fail means:** a crash or a hang in the picker, a status drawn from the broken log, a live record lost, or no note at all.

#### P22d-kill-switch

**Do:** with live records on screen (P22b), run `node refresh/observe-cli.mjs --off`, then `node refresh/observe-cli.mjs --status`, then
`node refresh/observe-cli.mjs --catchup`, then open the picker. Close it, run `node refresh/observe-cli.mjs --on` and open it again.

**Expected:** `--off` prints `disabled (created ...observe.off)`; `--status` starts with `DISABLED (remove observe.off or run --on)`; `--catchup` prints nothing and exits 0. The picker shows no
uppercase stat, no `live HH:MMZ`, no `(n live)` and no `[live` reply, exactly what `bench.json` alone would draw, and the modified time of `state/observed.run` does not move (no child
started). After `--on` (`enabled (removed ...observe.off)`) the live rows are back at the next open. Creating `state/observe.off` while a picker is already open changes that picker only at
its next open.

**Fail means:** any live marker with the switch off, a catch-up that reads the database or writes a file while off, or a live feed that does not return after `--on`.

#### P22e-lock-held

**Do:** create a lock that looks like a live run, then catch up and open the picker, all within two minutes:

```powershell
$ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
'{"pid":' + $PID + ',"startedAt":' + $ms + ',"maxMinutes":2}' | Set-Content state\observed.lock
node --no-warnings refresh/observe-cli.mjs --catchup
```

Open the picker (with `UW_OBSERVE_NO_SPAWN` unset, so the launcher's own lock gate is the one under test). Afterwards remove the lock: `Remove-Item state\observed.lock`.

**Expected:** the catch-up prints `observe: skipped (locked: another run holds the lock)` and exits 0. The picker opens at its usual speed, draws the last known live records and starts
no child (no new `node` process, no new `observed.json`); the lock file stays as you made it until you remove it. A lock whose process is gone, or that is older than 3 minutes, is taken
over by the next run.

**Fail means:** a second catch-up that runs anyway, a picker that waits on the lock, an error line, or a damaged `observed.json`.

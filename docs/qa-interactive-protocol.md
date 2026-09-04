# UW picker — interactive verification protocol

Twenty steps against live Claude Code in a real Windows Terminal. Each declares
**Do**, **Expected** and **Fail means**. Phase A is not complete until every step
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

**Expected:** `key id`, `models`, `free`, `health` in that order; rows show ids of
the shape `personal.google.free`; at least one row shows `—` in the free column
and at least one shows a number; `anthropic` shows `relay.anthropic.subscription`.

**Fail means:** a `0` where `—` belongs is the failure that matters most — it is
the design lying. `—` means "not yet determined"; `0` is a claim that the provider
has no free models.

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

**Expected:** `model`, `ctx`, `$in`, `$out`, `badge`, `caps`; context values render
as `163k` or `1M`; prices show two decimals; badges are only ever `FREE`, `FREE?`,
`PLAN`, `PAID` or blank; caps render as three characters drawn from `T`, `V`, `R`
and `-`; models CCR cannot resolve are visibly dimmer than the rest.

**Fail means:** any badge outside the five-value set, or a price with no decimals.

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
collapses to `switched -> provider/model`. Then hold the down arrow for two
seconds. Then close, set the kill switch, and reopen.

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

**Expected:** the legend replaces the rows and lists the keys including ctrl+f and
esc; the key that closes it does nothing else, so pressing esc to close does not
exit the picker; the filter still reads what it read before. With `zzzz` typed,
one line reads `no match for "zzzz" — backspace to widen, esc to clear` and the
help line is still visible at the bottom.

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

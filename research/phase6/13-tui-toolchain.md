# Research: TUI toolchain on Windows (2026-09-02)

Verified on this machine. Recommendation: **fzf**, with three corrections to commonly-repeated
claims.

## Corrections to received wisdom

**1. fzf does NOT default to `cmd.exe` on Windows.** It reads `$SHELL` first and only falls
back to `cmd /s/c`. From `src/util/util_windows.go`:
```go
shell := os.Getenv("SHELL")
if len(args) > 0 { shell = args[0] } else if len(shell) == 0 { shell = "cmd" }
// cmd* -> ["/s/c"]; pwsh*/powershell* -> ["-NoProfile","-Command"]; else -> ["-c"]
```
fzf has four separate hand-tested escaping paths (cmd caret-escaping, PowerShell
quote-doubling, POSIX). **A POSIX shell is not required for `--preview`.**

**But verified on this machine: `SHELL` is unset under PowerShell and
`C:\Program Files\Git\bin\bash.exe` under Git Bash** — so fzf would silently pick `cmd /s/c`
or `bash -c` depending on where the Node process was launched from. **Pin `--with-shell`
explicitly** (added 0.51.0; a quoted-args bug fixed in 0.71.0). This is the single most
important Windows detail.

**2. `--height` is not a conhost problem.** `src/options.go:3851`:
`// If --height option is not supported on the platform, just ignore it`. On any console
supporting `ENABLE_VIRTUAL_TERMINAL_PROCESSING` (Win10 1511+) it works; otherwise it
**silently degrades to fullscreen** — no crash. 0.74.2 added resize detection in `--height`
mode on Windows.

**3. The robustness story is better than expected — fzf ships two renderers.** Fullscreen uses
**tcell**, driving the Win32 Console API directly (no VT needed); `--height` uses the ANSI
light renderer. **That dual path is why fzf survives conhost, and no Node library here matches
it.**

## What follows

- **Do not nest fzf inside `reload`** — `reload` does not hand over the TTY, so the inner fzf has no terminal (fzf #2834). The correct pattern is **two sequential invocations driven from Node**, with `--expect=left,backspace` on level 2 so Node detects "go back". Exit 130 = cancel, 1 = no match.
- **No Windows-specific `reload` breakage exists in current fzf.** The historical issues predate the 0.51-0.74 Windows work. Residual risk is quoting, not capability — mitigated by `--with-shell`.
- **Master-detail is the dominant TUI pattern** (fzf, skim, television, lazygit, k9s), independently supporting overflow columns in `--preview` rather than horizontal scrolling.

## `--listen` — genuinely useful

`--listen[=[ADDR:]PORT]` starts an HTTP control server. Node can `POST` actions
(`reload(...)+change-prompt(...)+change-header(...)`) and `GET` fzf's state as JSON. **This
lets you drive the two-level UI programmatically instead of encoding logic into Windows shell
strings** — a meaningful robustness win, and the escape hatch if shell quoting ever bites.

## Column mechanics — fzf has no built-in alignment

Pad in Node, then `--delimiter` + `--with-nth` for display and `--nth` for search scope.

Gotchas:
- With a literal single-space delimiter, consecutive spaces become *empty* fields — use `--delimiter='\s\s+'`.
- When `--nth` and `--with-nth` combine, `--nth` indexes the **transformed** line (unlike `--preview`, which sees the original).
- `--header-lines=1` pins a header.
- **There is no `column -t` on Windows** — pad yourself, using `string-width` (not `String.length`, and **not `util.getStringWidth`, which was confirmed `undefined` in Node v25**).
- Use `--border=sharp` (fzf's own Windows default since 0.36.0, because "some Windows terminals render `rounded` incorrectly") and ASCII separators — box-drawing chars are UAX #11 "Ambiguous" width and render as two columns under CJK locales in conhost.

## The in-process fallback is narrower than it looks

If refusing an external binary, use **Ink 7.1.1** — *not* the 6.6.0 present on disk as a
transitive dep of `command-code`. `alternateScreen: true` only exists in Ink 7. And there is a
verified Windows landmine in `build/ink.js`:
```js
const isWindowsConsole = process.platform === 'win32';
if (isWindowsConsole && (wasFullscreen || isFullscreen)) return true;  // full clear
```
with `isFullscreen = outputHeight >= viewportRows`. **On Windows, once your frame is as tall
as the terminal, every render does a full erase and repaint.** So virtualize the list yourself
and hard-cap the frame at `rows - 1` lines to stay off that path. Ink 7 emits synchronized
output (`\x1b[?2026h`), which Windows Terminal 1.24 supports — but conhost will flicker.

## Ruled out

- **blessed** — last release **2015**. **neo-blessed** — **2018**. Dead.
- **terminal-kit** — actively maintained (3.1.4, 2026-07), but its README mentions Windows zero times and the signature failure is `getCursorLocation() timed out` on Windows.
- **`Out-ConsoleGridView`** — taken seriously and it fails on two counts. `PowerShell/ConsoleGuiTools` is **archived** (`"archived": true`), pinned to Terminal.Gui v1, last release 2024-05-01. Worse: its `WindowsDriver` takes `GetStdHandle(STD_OUTPUT_HANDLE)` rather than opening `CONOUT$` (which fzf does explicitly), so **spawning it from Node with piped stdout to capture the selection breaks rendering**. Workaround would be inherited stdio + a temp file. Not worth it.
- **skim (`sk` 5.6.6)** — a live alternative that *does* support Windows now (MSVC builds, winget/scoop), contrary to older claims, but explicitly not a drop-in fzf clone and `reload` is undocumented.
- **gum 2.0.0** — ships Windows builds (scoop manifest is `charm-gum`, not `gum`) but weaker for large lists.

## Concrete shape

```
scoop install fzf          # 0.74.3 manifest already on disk, main bucket
```

- Node builds padded rows → `spawn(fzf, args, {stdio: ['pipe','pipe','inherit']})`. **stderr inherited** — fzf draws on stderr, and a real console there keeps `--height` available.
- Pin `--with-shell "cmd /s/c"`, `--border=sharp`, `--delimiter='\s\s+'`, `--with-nth`, `--nth`, `--header-lines=1`, `--preview 'node preview.mjs {}'`.
- Level 2 gets `--expect=left,backspace` for back-navigation.
- Per the information-architecture finding, **one** invocation over ~744 rows is likely sufficient, not two.

param(
  [string]$File,
  [string]$ChildScript = "uwpick.mjs",
  [switch]$Diagnose
)

# Node cannot call SetConsoleMode, and that is the whole problem.
#
# MEASURED under CC's ctrl+g handoff: the child gets stdin.isTTY = undefined,
# no setRawMode, and 0 bytes ever delivered on process.stdin. The console input
# device "//./CONIN$" DOES open and a blocking read on it returns keystrokes --
# but only in whatever mode the console happens to be in. CC calls
# enterAlternateScreen() before spawning, which turns raw mode OFF, leaving the
# console line-buffered with echo. In that mode arrow keys are swallowed by the
# console's own line editor and characters are not delivered until Enter.
#
# So: flip the console to raw VT input for the duration of the picker, then put
# it back exactly as we found it. The restore runs in `finally` so it also
# happens on ctrl+c or a crash -- leaving a console in raw mode would make the
# parent shell unusable, and that failure reads as a broken terminal rather than
# a broken picker.

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class ConMode {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr CreateFile(string name, uint access, uint share,
      IntPtr sec, uint disp, uint flags, IntPtr templ);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetConsoleMode(IntPtr h, uint mode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool FlushConsoleInputBuffer(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue

# Decimal, not hex, and this is not a style choice: PowerShell 5.1 parses the
# hex form of GENERIC_READ|GENERIC_WRITE as an Int32, which overflows to
# -1073741824, and the [uint32] cast then throws before the P/Invoke is ever
# reached. The literal is deliberately not written in hex anywhere in this file.
$ACCESS_RW     = [uint32]3221225472   # GENERIC_READ | GENERIC_WRITE
$SHARE_RW      = [uint32]3
$OPEN_EXISTING = [uint32]3

# CreateFile on CONIN$, not GetStdHandle: under the handoff stdin may be
# redirected, but CONIN$ always names the real console input buffer.
$h = [ConMode]::CreateFile("CONIN$", $ACCESS_RW,
                           $SHARE_RW, [IntPtr]::Zero, $OPEN_EXISTING, [uint32]0, [IntPtr]::Zero)
if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) {
  Write-Host "uwpick: cannot open CONIN$ ($([ComponentModel.Win32Exception]::new(
    [Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message))"
  exit 1
}

$saved = 0
$haveSaved = [ConMode]::GetConsoleMode($h, [ref]$saved)

# ENABLE_VIRTUAL_TERMINAL_INPUT (0x200) makes the console emit arrows as the VT
# sequences the picker already parses (ESC [ A/B). Deliberately NOT set:
#   ENABLE_LINE_INPUT (0x02)     -- would buffer until Enter
#   ENABLE_ECHO_INPUT (0x04)     -- would echo filter text over our own rendering
#   ENABLE_PROCESSED_INPUT(0x01) -- would eat ctrl+c instead of delivering byte 3
$RAW_VT = [uint32](0x0080 -bor 0x0200)   # ENABLE_EXTENDED_FLAGS | ENABLE_VIRTUAL_TERMINAL_INPUT
[void][ConMode]::SetConsoleMode($h, $RAW_VT)

# Discard whatever the handoff left behind, or the picker's first readSync eats
# it instead of the user's first keypress.
#
# MEASURED: launched through Claude Code's ctrl+g, the picker drew correctly but
# ignored the first key -- arrows did nothing until some key had been pressed
# once. Launched DIRECTLY against the same buffer file, arrows worked
# immediately. That difference is the whole diagnosis: the console input buffer
# is shared, and the key records left over from the ctrl+g press itself are still
# queued when we open it. The picker consumed them as its first read, found
# nothing it recognised, and redrew unchanged.
#
# Nothing legitimate is lost. The only input that can be pending at this instant
# is what was typed before the picker existed, which the user cannot have aimed
# at a menu that was not on screen yet.
[void][ConMode]::FlushConsoleInputBuffer($h)

$childExit = 0
try {
  & node (Join-Path $PSScriptRoot $ChildScript) $File
  $childExit = $LASTEXITCODE
} finally {
  if ($haveSaved) { [void][ConMode]::SetConsoleMode($h, $saved) }
  if ($Diagnose) {
    $after = 0
    [void][ConMode]::GetConsoleMode($h, [ref]$after)
    $dir = Join-Path $env:USERPROFILE ".uw\state"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $report = @{ saved = [int]$saved; set = [int]$RAW_VT; restored = [int]$after
                 childExit = [int]$childExit } | ConvertTo-Json -Compress
    # Q2.9: NOT Set-Content -Encoding UTF8. In PowerShell 5.1 that writes a UTF-8
    # BOM, JSON.parse throws on a leading U+FEFF, and menu/atomic.mjs:readJsonOr
    # would return its fallback -- so the console-mode test below would read an
    # empty object and conclude the restore never happened, or that it did,
    # depending on which way the assertion was written. Neither would be a
    # measurement. UTF8Encoding($false) is the BOM-free constructor.
    # Q2.8: temp + Move-Item, so a ctrl+c here cannot leave a half-written report.
    $tmp = (Join-Path $dir "conmode.json.uw-tmp")
    [IO.File]::WriteAllText($tmp, $report, (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $tmp -Destination (Join-Path $dir "conmode.json") -Force
  }
  [void][ConMode]::CloseHandle($h)
}
exit $childExit

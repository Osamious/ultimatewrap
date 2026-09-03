param([string]$File)

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
# parent shell unusable.

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
  public static extern bool CloseHandle(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop

# Decimal, not hex, and this is not a style choice: PowerShell 5.1 parses
# 0xC0000000 as an Int32, which overflows to -1073741824, and the [uint32] cast
# then throws before the P/Invoke is ever reached.
$ACCESS_RW     = [uint32]3221225472   # GENERIC_READ (0x80000000) | GENERIC_WRITE (0x40000000)
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
#   ENABLE_LINE_INPUT (0x02)  -- would buffer until Enter
#   ENABLE_ECHO_INPUT (0x04)  -- would echo filter text over our own rendering
#   ENABLE_PROCESSED_INPUT(0x01) -- would eat ctrl+c instead of delivering byte 3
$RAW_VT = [uint32](0x0080 -bor 0x0200)   # ENABLE_EXTENDED_FLAGS | ENABLE_VIRTUAL_TERMINAL_INPUT
[void][ConMode]::SetConsoleMode($h, $RAW_VT)

try {
  & node "$PSScriptRoot/uwpick.mjs" $File
  exit $LASTEXITCODE
} finally {
  if ($haveSaved) { [void][ConMode]::SetConsoleMode($h, $saved) }
  [void][ConMode]::CloseHandle($h)
}

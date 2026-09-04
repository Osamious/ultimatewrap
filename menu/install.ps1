param(
  [switch]$Force,
  [switch]$WhatIf,
  # Q6.3: the statusline shim is opt-in and separately reversible.
  [switch]$Hud,
  [switch]$HudUninstall,
  # Injected only by tests, so no test ever reads or writes the live settings
  # file (constraint 15).
  [string]$SettingsFile = (Join-Path $env:USERPROFILE ".claude\settings.json"),
  [string]$StateFile = (Join-Path $env:USERPROFILE ".uw\state\install.json"),
  # Injected only by tests. In normal use the current value is read from the
  # User environment, which is the thing we are about to change.
  [string]$CurrentEditor = $null,
  # Anything not matched above lands here so a MISTYPED switch is an error rather
  # than silence. `-HudUinstall` (one `n` short) was accepted without complaint,
  # the statusline section never ran, and the script printed its ordinary success
  # message -- so the operator believed the shim had been removed when it was
  # still installed, and every reading taken afterwards was of the wrong thing.
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Unrecognised
)

if ($Unrecognised) {
  Write-Host "install: unrecognised argument(s): $($Unrecognised -join ', ')"
  Write-Host "  valid: -Force -WhatIf -Hud -HudUninstall"
  exit 2
}

# -HudUninstall implies -Hud. The uninstall branch lives inside `if ($Hud)`, so
# on its own the flag did nothing at all -- no output about the statusline, exit
# 0, and the ordinary "Done." message. A user following the documented uninstall
# and omitting -Hud was told it had worked. Making it imply the section is the
# fix rather than adding a second thing to remember, since -HudUninstall is
# meaningless without it.
if ($HudUninstall) { $Hud = $true }

# Wire ctrl+g to the UW picker without destroying whatever the user already had.
#
# The failure this guards against is specific and unrecoverable: EDITOR is a
# single string. If we overwrite a real editor path and the user later uninstalls
# UW, ctrl+g silently opens notepad forever and the original setting is gone.
# So: record what we set, and refuse to touch an EDITOR whose value we do not
# recognise as our own.

$ErrorActionPreference = "Stop"
$dispatcher = Join-Path $PSScriptRoot "uwpick.cmd"

if (-not (Test-Path $dispatcher)) {
  Write-Host "install: cannot find $dispatcher"
  exit 1
}

if ($PSBoundParameters.ContainsKey("CurrentEditor")) {
  $current = $CurrentEditor
} else {
  $current = [Environment]::GetEnvironmentVariable("EDITOR", "User")
}

$prior = $null
if (Test-Path $StateFile) {
  try { $prior = Get-Content -Raw $StateFile | ConvertFrom-Json } catch { $prior = $null }
}

$normalize = { param($p) ($p -replace '\\','/').ToLowerInvariant() }
$isOurs = $current -and $prior -and $prior.editorSetBy -eq "uw" -and
          (& $normalize $current) -eq (& $normalize $prior.editorValue)
$isAlreadyDispatcher = $current -and ((& $normalize $current) -eq (& $normalize $dispatcher))

$realEditor = $null
if ($current -and -not $isOurs -and -not $isAlreadyDispatcher) {
  if (-not $Force) {
    Write-Host "install: refusing to overwrite EDITOR."
    Write-Host "  current: $current"
    Write-Host "  this was not set by UW, and replacing it would lose the only copy."
    Write-Host "  Re-run with -Force to move it into UW_REAL_EDITOR and continue."
    exit 2
  }
  $realEditor = $current
}

if (-not $realEditor) {
  $existingReal = [Environment]::GetEnvironmentVariable("UW_REAL_EDITOR", "User")
  if ($existingReal) { $realEditor = $existingReal }
  elseif ($prior -and $prior.previousEditor) { $realEditor = $prior.previousEditor }
  else { $realEditor = "$env:SystemRoot\system32\notepad.exe" }
}

Write-Host "EDITOR         -> $dispatcher"
Write-Host "UW_REAL_EDITOR -> $realEditor"

# One BOM-free, atomic JSON write, used for every file this script produces.
# Q2.9: PowerShell 5.1's `Set-Content -Encoding UTF8` writes a UTF-8 BOM and
# JSON.parse throws on it, so every reader in this project would silently fall
# back to an empty object. UTF8Encoding($false) is the BOM-free constructor.
# Q2.8: temp file plus Move-Item -Force, which is an atomic rename on NTFS for a
# same-directory destination, so a ctrl+c mid-write cannot truncate the target.
function Write-JsonFile([string]$Path, [string]$Text) {
  $dir = Split-Path $Path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$Path.uw-tmp"
  [IO.File]::WriteAllText($tmp, $Text, (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# -WhatIf must not return early when -Hud is also asked for, or the entire
# statusline half of this installer is unreachable in a dry run -- which is the
# only way its tests can exercise it, since they must never touch the live
# settings.json. The environment writes are still skipped; only the reporting
# continues.
if ($WhatIf) {
  Write-Host "(-WhatIf: nothing was changed)"
  if (-not $Hud) { exit 0 }
} else {
  [Environment]::SetEnvironmentVariable("EDITOR", $dispatcher, "User")
  [Environment]::SetEnvironmentVariable("UW_REAL_EDITOR", $realEditor, "User")

  Write-JsonFile $StateFile (@{ editorSetBy = "uw"; editorValue = $dispatcher
    previousEditor = $current; realEditor = $realEditor
    at = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json)
}

# ---- optional: the statusline shim (Q6.3, Q6.4) ---------------------------
# Off unless asked. It changes ONE key in Claude Code's settings.json, keeps the
# original bytes in settings.json.uw-bak, and restores from those bytes on
# -HudUninstall. It never touches an OMC file.
if ($Hud) {
  $settingsPath = $SettingsFile
  $hudState     = Join-Path (Split-Path $StateFile) "hud-install.json"
  $shim         = Join-Path $PSScriptRoot "hud-shim.mjs"
  $nodeEdit     = Join-Path $PSScriptRoot "set-statusline.mjs"

  if (-not (Test-Path $settingsPath)) { Write-Host "hud: no settings.json at $settingsPath"; exit 3 }

  # READ-ONLY here. $json INSPECTS the current value and is never written back.
  # The write goes through set-statusline.mjs below, which round-trips JSON
  # losslessly.
  #
  # Why not "($json | ConvertTo-Json -Depth 20) | Set-Content": that re-serialises
  # the user's entire Claude Code configuration in order to change one string.
  # PowerShell 5.1's round trip collapses single-element arrays to scalars -- a
  # one-entry permissions.allow or a one-entry hook array comes back as a bare
  # value and stops being a list -- re-escapes non-ASCII into backslash-u escapes,
  # renormalises numbers, and reformats indentation. The blast radius is the whole
  # file, and this is the one file the plan promises not to disturb.
  $json = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json
  $currentCommand = $json.statusLine.command

  if ($HudUninstall) {
    if (-not (Test-Path $hudState)) { Write-Host "hud: not installed"; exit 0 }
    $prevHud = Get-Content -Path $hudState -Raw | ConvertFrom-Json
    $bak = "$settingsPath.uw-bak"

    # GUARD 1: is the shim still ours to remove?
    #
    # OMC owns statusLine.command too. `/omc-setup` and `omc-doctor` both write it,
    # and either can replace UW's wrapper with OMC's own bare command at any time.
    # When that has happened the wrapper is already gone -- which degrades
    # correctly, the footer simply works as it always did -- but hud-install.json
    # is now STALE, and writing its recorded previousCommand back would overwrite
    # whatever OMC just set. Uninstall would then look like it worked and would
    # have reverted an OMC update. Detect it, say so, and clear only our own state.
    if ($currentCommand -notlike "*hud-shim.mjs*") {
      Write-Host "hud: statusLine.command is no longer UW's wrapper -- something else"
      Write-Host "     (most likely an OMC setup or doctor run) has already rewritten it to:"
      Write-Host "       $currentCommand"
      Write-Host "     Leaving it alone and removing UW's stale state file only."
      if (-not $WhatIf) { Remove-Item $hudState -Force }
      exit 0
    }

    # GUARD 2: does the backup differ from the live file in NOTHING BUT statusLine?
    #
    # Q6.4 promises a byte-for-byte restore, and $bak is the only thing that can
    # deliver one. But settings.json is a shared file with 20-plus top-level keys --
    # `hooks`, `permissions`, `modelPicker`, `enabledPlugins`, `env` -- owned by
    # Claude Code, by OMC, and by the user. Copying the whole backup over the live
    # file reverts every one of those to its state at install time.
    #
    # Comparing only statusLine.command (which an earlier draft of this plan did)
    # is not enough: it says the field we changed is unchanged, and says nothing
    # about the twenty fields we did not. So compare the two documents with
    # `statusLine` removed. Identical means we are the only writer since install and
    # the whole-file copy is safe; different means someone else has written to this
    # file and only the value edit is honest.
    $canRestoreBytes = $false
    if (Test-Path $bak) {
      try {
        $bakJson = Get-Content -Path $bak -Raw | ConvertFrom-Json
        $bakCmd  = $bakJson.statusLine.command
        $liveRest = $json      | Select-Object -Property * -ExcludeProperty statusLine | ConvertTo-Json -Depth 30 -Compress
        $bakRest  = $bakJson   | Select-Object -Property * -ExcludeProperty statusLine | ConvertTo-Json -Depth 30 -Compress
        $canRestoreBytes = ($bakCmd -ceq $prevHud.previousCommand) -and ($liveRest -ceq $bakRest)
      } catch { $canRestoreBytes = $false }
    }

    if ($WhatIf) {
      $how = if ($canRestoreBytes) { "byte for byte from $bak" } else { "value edit; other keys have changed since install" }
      Write-Host ("hud: would restore -> {0} ({1})" -f $prevHud.previousCommand, $how)
      exit 0
    }

    if ($canRestoreBytes) {
      Copy-Item $bak $settingsPath -Force
      Write-Host "hud: restored byte for byte from $bak"
    } else {
      # Honest fallback, and it announces itself rather than claiming otherwise.
      # This is the CORRECT path whenever anyone else has touched settings.json
      # since the install, which for a file OMC and Claude Code both write is the
      # expected case rather than the exception.
      $env:UW_STATUSLINE_COMMAND = $prevHud.previousCommand
      & node $nodeEdit $settingsPath
      if ($LASTEXITCODE -ne 0) { Write-Host "hud: restore FAILED; $bak still holds the original"; exit 1 }
      Write-Host "hud: restored the statusLine VALUE but not byte for byte -- other keys in"
      Write-Host "     settings.json have changed since the install, so the backup is not safe"
      Write-Host "     to copy wholesale. Those changes are preserved; the file is reformatted."
    }
    Remove-Item $hudState -Force
    Write-Host "hud: statusLine -> $($prevHud.previousCommand)"
    exit 0
  }

  if ($currentCommand -like "*hud-shim.mjs*") { Write-Host "hud: already installed"; exit 0 }
  if (-not $currentCommand) { Write-Host "hud: no statusLine.command to wrap"; exit 3 }

  $wrapped = "node `"$($shim -replace '\\','/')`" -- $currentCommand"
  Write-Host "statusLine     -> $wrapped"
  if ($WhatIf) { Write-Host "(-WhatIf: nothing was changed)"; exit 0 }

  Copy-Item $settingsPath "$settingsPath.uw-bak" -Force
  Write-JsonFile $hudState (@{ previousCommand = $currentCommand
    wrappedAt = (Get-Date).ToUniversalTime().ToString("o")
    settings = $settingsPath } | ConvertTo-Json)

  # The write itself: Node, not PowerShell. JSON.parse/JSON.stringify round-trips
  # this file without losing array-ness, and set-statusline.mjs writes it through
  # menu/atomic.mjs -- BOM-free and atomic (Q2.8, Q2.9), which Set-Content is
  # neither.
  #
  # The command travels in an environment variable, NOT in argv. PowerShell 5.1
  # strips embedded `"` from a string passed as an argument to a native command,
  # so `& node $nodeEdit $settingsPath $wrapped` wrote an unquoted
  #   node C:/.../hud-shim.mjs -- C:\nvm4w\nodejs\node.exe C:/.../omc-hud.mjs
  # for the correctly quoted $wrapped echoed two lines above. Claude Code runs
  # the statusline through a POSIX-ish shell, which ate the now-unguarded
  # backslashes, and the footer was blank on every prompt. See set-statusline.mjs.
  $env:UW_STATUSLINE_COMMAND = $wrapped
  & node $nodeEdit $settingsPath
  if ($LASTEXITCODE -ne 0) { Write-Host "hud: FAILED to write settings.json; it is unchanged"; exit 1 }
  Write-Host "hud: installed. Previous command saved to $hudState"
}

Write-Host ""
Write-Host "Done. Open a NEW terminal (User-scope variables do not reach running processes),"
Write-Host "start Claude Code, type 'm' in the chat input, THEN press ctrl+g."
Write-Host "(That order matters: uwpick.cmd dispatches on the buffer's first line, so"
Write-Host " ctrl+g on an empty prompt correctly opens your real editor instead.)"
exit 0

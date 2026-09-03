# Registers UW process supervision as a Windows scheduled task.
#
# Runs as the current user (NOT SYSTEM) and only while logged on — both are
# required, not incidental: the relay reads ~/.claude/.credentials.json and CCR
# reads per-user AppData and Windows Credential Manager, all of which are
# DPAPI-scoped to the logged-on user.
#
#   .\install-supervision.ps1              install/refresh
#   .\install-supervision.ps1 -Uninstall   remove

[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$TaskName   = 'UW Process Supervision'
$Script     = Join-Path $HOME '.uw\supervise\uw-supervise.ps1'
$IntervalMin = 5

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "removed scheduled task '$TaskName'"
  return
}

if (-not (Test-Path $Script)) { throw "supervisor script not found at $Script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`" -Once"

# Two triggers: cover the boot/login gap, then keep checking. The repeating
# check is what turns this into supervision rather than just a startup item.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMin)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew    # a slow run must never stack up behind itself

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action `
  -Trigger @($atLogon, $repeat) -Settings $settings -Principal $principal -Force | Out-Null

Write-Output "registered '$TaskName' (at logon + every $IntervalMin min, as $env:USERNAME, non-elevated)"
Write-Output "check:  powershell -File `"$Script`" -Status"
Write-Output "logs:   $(Join-Path $HOME '.uw\supervise\supervise.log')"

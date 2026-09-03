# Phase 5, Stage E — LIVE gateway/relay recovery test.
#
# WARNING: this kills the CCR gateway and the OAuth relay. Every Claude Code
# session on this machine routes through them, so ALL sessions — including any
# other one you have open — will fail to send until recovery completes. That is
# the behaviour under test, not a side effect.
#
#   .\test-recovery.ps1           forced: triggers the scheduled task immediately (~30-60s)
#   .\test-recovery.ps1 -Wait     passive: waits for the 5-minute schedule to fire on its own
#
# If anything goes wrong, the manual escape hatch is at the bottom of this file.

[CmdletBinding()]
param([switch]$Wait)

$ErrorActionPreference = 'Continue'
$Task = 'UW Process Supervision'

function PidOn([int]$Port) {
  (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1).OwningProcess
}
function StartedAt([int]$ProcId) {
  if (-not $ProcId) { return $null }
  (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue).CreationDate
}

Write-Output '=== BEFORE ==='
$gwBefore    = PidOn 3456
$relayBefore = PidOn 4517
Write-Output "gateway 3456: pid $gwBefore"
Write-Output "relay   4517: pid $relayBefore"
if (-not $gwBefore -or -not $relayBefore) {
  Write-Output 'ABORT: one of them is already down; bring both up first so the test means something.'
  exit 2
}

Write-Output ''
Write-Output '=== KILLING BOTH (all Claude Code sessions will fail from here) ==='
# Kill BOTH deliberately: killing only the gateway never exercises the
# relay-first ordering, which is the part that matters for Anthropic rows.
Stop-Process -Id $gwBefore    -Force -ErrorAction SilentlyContinue
Stop-Process -Id $relayBefore -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Write-Output "gateway down: $(-not (PidOn 3456))"
Write-Output "relay   down: $(-not (PidOn 4517))"
$killedAt = Get-Date

Write-Output ''
if ($Wait) {
  Write-Output '=== PASSIVE: waiting for the 5-minute schedule (up to 7 min) ==='
  Write-Output 'This measures the real unattended recovery latency.'
} else {
  Write-Output '=== FORCED: triggering the scheduled task now ==='
  Start-ScheduledTask -TaskName $Task
}

$deadline = (Get-Date).AddMinutes($(if ($Wait) { 7 } else { 2 }))
while ((Get-Date) -lt $deadline) {
  if ((PidOn 3456) -and (PidOn 4517)) { break }
  Start-Sleep -Seconds 5
}

$gwAfter    = PidOn 3456
$relayAfter = PidOn 4517
$elapsed    = ((Get-Date) - $killedAt).TotalSeconds

Write-Output ''
Write-Output '=== AFTER ==='
Write-Output ("recovered in {0:n0}s" -f $elapsed)
Write-Output "gateway 3456: pid $gwAfter (was $gwBefore)"
Write-Output "relay   4517: pid $relayAfter (was $relayBefore)"

$ok = [bool]$gwAfter -and [bool]$relayAfter
if ($ok) {
  $rStart = StartedAt $relayAfter
  $gStart = StartedAt $gwAfter
  $orderOk = $rStart -le $gStart
  Write-Output "relay started $($rStart.ToString('HH:mm:ss')) / gateway $($gStart.ToString('HH:mm:ss')) -> relay first: $orderOk"

  Write-Output ''
  Write-Output '=== ROUTING SMOKE TEST (the assertion that actually matters) ==='
  # "/model still renders" would pass with the gateway uninstalled, so it proves
  # nothing. Routing is the real post-recovery claim.
  $env:ANTHROPIC_API_KEY = $null
  & "$HOME\.local\bin\claude.exe" --model 'anthropic/claude-sonnet-5' -p 'Reply with the single word: recovered' 2>&1 |
    Select-Object -First 3
} else {
  Write-Output 'RECOVERY FAILED — see the escape hatch below.'
}

Write-Output ''
Write-Output '=== VERDICT ==='
Write-Output "both processes back: $ok"
Write-Output "supervisor log:"
Get-Content "$HOME\.uw\supervise\supervise.log" -Tail 5 -ErrorAction SilentlyContinue

Write-Output ''
Write-Output 'If recovery failed, run these two by hand:'
Write-Output '  Start-Process node -ArgumentList "$HOME\.local\bin\anthropic-oauth-relay.mjs" -WindowStyle Hidden'
Write-Output '  ccr start'

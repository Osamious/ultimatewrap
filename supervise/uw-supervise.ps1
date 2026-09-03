# UW process supervision — replaces the deprecated ccr-watchdog.ps1.
#
# DESIGN INTENT: "ensure running", not a heal state machine. The watchdog it
# replaced was 339 lines with --observe/--heal modes, bounded restart counters,
# pause sentinels and a restart-suppression marker; three review rounds each
# found a regression introduced by the previous fix.
#
# It now checks HEALTH, not just a listening port, because every failure that
# actually bit us lives above the socket layer: an expired OAuth token, a wedged
# daemon, or a foreign process squatting the port all read as UP to a port probe.
# The guard against the old watchdog's thrashing is a two-failure confirmation,
# which is one counter in a file — not a state machine.
#
# Supervises the two processes UW put in the critical path. Before UW, Claude
# Code talked straight to api.anthropic.com; now every request goes through the
# CCR gateway, and Claude models additionally through the OAuth relay. Either
# being down takes Claude Code out entirely.
#
#   -Once     single check (what the scheduled task runs)
#   -Status   report only, change nothing

[CmdletBinding()]
param(
  [switch]$Once,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'

$RelayScript = Join-Path $HOME '.local\bin\anthropic-oauth-relay.mjs'
$RelayPort   = 4517
$GatewayPort = 3456
$LogFile     = Join-Path $HOME '.uw\supervise\supervise.log'
$StateFile   = Join-Path $HOME '.uw\supervise\supervise-state.json'
$MaxLogBytes = 512KB

function Write-Log([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
      Move-Item $LogFile "$LogFile.1" -Force
    }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }   # never let logging failure take the supervisor down
  # Write-Host, not Write-Output: Write-Output puts the line on the pipeline,
  # so a caller that discards a function's return value ([void](Start-Relay))
  # silently swallows the log line with it. Cost me a false 'never restarts'
  # reading in the sandbox until the log file contradicted the console.
  Write-Host $line
}

function Test-Listening([int]$Port) {
  try { $null = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop; return $true }
  catch { return $false }
}

# Health, not just liveness. Both processes serve /health in ~1.5ms, and the
# relay's now reports token expiry rather than unconditionally returning ok.
function Test-Healthy([int]$Port) {
  if (-not (Test-Listening $Port)) { return $false }
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    # CCR answers /health; a non-2xx or a refusal both mean unhealthy. A foreign
    # process squatting the port also lands here, which is the point.
    return $false
  }
}

function Get-State {
  if (Test-Path $StateFile) {
    try { return Get-Content $StateFile -Raw | ConvertFrom-Json } catch { }
  }
  return [pscustomobject]@{ relayFails = 0; gatewayFails = 0 }
}
function Set-State($relayFails, $gatewayFails) {
  try {
    @{ relayFails = $relayFails; gatewayFails = $gatewayFails; lastRun = (Get-Date).ToString('o') } |
      ConvertTo-Json | Set-Content $StateFile -Encoding UTF8
  } catch { }
}

function Start-Relay {
  if (-not (Test-Path $RelayScript)) {
    Write-Log "ERROR relay script missing at $RelayScript"
    return $false
  }
  # Capture the relay's output. It was previously started with no redirection,
  # so when it crashed there was no record of why — which is the main reason its
  # crash class went unnoticed while CCR's log accumulated ECONNREFUSED rows.
  $relayOut = Join-Path $HOME '.uw\supervise\relay.log'
  $relayErr = Join-Path $HOME '.uw\supervise\relay.err.log'
  foreach ($f in @($relayOut, $relayErr)) {
    if ((Test-Path $f) -and ((Get-Item $f).Length -gt 2MB)) { Move-Item $f "$f.1" -Force }
  }
  # Detached and windowless. Started from a scheduled task it has no shell
  # parent, which is the actual bug this replaces: the relay had been running as
  # a child of an interactive session and would have died with it.
  Start-Process -FilePath 'node' -ArgumentList "`"$RelayScript`"" -WindowStyle Hidden `
    -RedirectStandardOutput $relayOut -RedirectStandardError $relayErr
  Start-Sleep -Seconds 2
  if (Test-Listening $RelayPort) { Write-Log "started relay on $RelayPort"; return $true }
  Write-Log "WARN relay did not come up on $RelayPort within 2s"
  return $false
}

function Start-Gateway {
  # MEASURED: `(Get-Command ccr).Source` resolves to ccr.ps1, an ExternalScript
  # that Start-Process cannot launch ("cannot find all the information
  # required"). Resolve the .cmd shim explicitly. This path had never actually
  # run until a sandbox test forced it — the relay-only restart tested earlier
  # never reached it.
  $ccr = @(
    (Get-Command 'ccr.cmd' -ErrorAction SilentlyContinue).Source,
    (Join-Path (Split-Path (Get-Command node).Source) 'ccr.cmd')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $ccr) { Write-Log 'ERROR ccr.cmd not found on PATH'; return $false }
  # NO -Wait. `ccr start` spawns a detached daemon and the .cmd shim does not
  # reliably exit, so -Wait hangs the supervisor indefinitely. With the task's
  # MultipleInstances=IgnoreNew that means every later scheduled run is skipped —
  # supervision goes alive-but-inert after its first real gateway restart, which
  # is exactly the failure the predecessor watchdog was retired for. Observed
  # live 2026-09-02: two instances stuck Running.
  Start-Process -FilePath $ccr -ArgumentList 'start' -WindowStyle Hidden
  # Poll instead of sleeping a fixed amount: bounded, and returns as soon as the
  # port is actually listening.
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Listening $GatewayPort) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Test-Listening $GatewayPort) { Write-Log "started CCR gateway on $GatewayPort"; return $true }
  Write-Log "WARN CCR gateway did not come up on $GatewayPort"
  return $false
}

# Kill whatever holds the port before restarting: an unhealthy-but-listening
# process (wedged daemon, foreign squatter) would otherwise block the restart,
# and `ccr start` would report "already running".
function Stop-PortOwner([int]$Port, [string]$Label) {
  try {
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -First 1).OwningProcess
    if ($owner) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
                  Write-Log "stopped unhealthy $Label (pid $owner) on $Port" }
  } catch { }
}

$relayHealthy   = Test-Healthy $RelayPort
$gatewayHealthy = Test-Healthy $GatewayPort

if ($Status) {
  "relay   ($RelayPort):   {0}" -f $(if ($relayHealthy)   { 'HEALTHY' } elseif (Test-Listening $RelayPort)   { 'LISTENING BUT UNHEALTHY' } else { 'DOWN' })
  "gateway ($GatewayPort): {0}" -f $(if ($gatewayHealthy) { 'HEALTHY' } elseif (Test-Listening $GatewayPort) { 'LISTENING BUT UNHEALTHY' } else { 'DOWN' })
  $st = Get-State
  if ($st.lastRun) {
    $age = ((Get-Date) - [datetime]$st.lastRun).TotalMinutes
    "last supervisor run: {0} ({1:n0} min ago){2}" -f $st.lastRun, $age, $(if ($age -gt 15) { '  *** STALE - is the scheduled task still registered? ***' } else { '' })
  } else { "last supervisor run: never recorded" }
  if (Test-Path $LogFile) { "`nrecent:"; Get-Content $LogFile -Tail 8 }
  return
}

$state = Get-State
$relayFails   = if ($relayHealthy)   { 0 } else { [int]$state.relayFails + 1 }
$gatewayFails = if ($gatewayHealthy) { 0 } else { [int]$state.gatewayFails + 1 }

# Two consecutive failures before acting. A health check that restarts on the
# first blip thrashes — one of the defects that retired the old watchdog.
$RESTART_AFTER = 2
# ...and back off after that, or a permanently broken service (node missing, a
# revoked token the relay cannot refresh) gets a fresh spawn attempt every run,
# forever. MEASURED in the sandbox: with a flat threshold, two dead ports
# produced a restart attempt on every second run indefinitely. Attempt at 2,
# then hourly (every 12th run at the task's 5-minute cadence).
function Should-Restart([int]$fails) {
  if ($fails -lt $RESTART_AFTER) { return $false }
  return ((($fails - $RESTART_AFTER) % 12) -eq 0)
}

# Relay first: the gateway's Anthropic provider points at it, so restarting the
# gateway against a dead relay yields auth failures on the first Claude request.
if (-not $relayHealthy) {
  Write-Log "relay unhealthy (consecutive: $relayFails/$RESTART_AFTER)"
  if (Should-Restart $relayFails) {
    Stop-PortOwner $RelayPort 'relay'
    # Deliberately NOT resetting the counter on a successful spawn. Start-Relay
    # only proves the port is listening, and listening-but-unhealthy (expired
    # token) is precisely the class this health check exists to catch — zeroing
    # here would restart it every 10 minutes forever. The counter clears itself
    # on the next run whose health check actually passes.
    [void](Start-Relay)
  }
}
if (-not $gatewayHealthy) {
  Write-Log "gateway unhealthy (consecutive: $gatewayFails/$RESTART_AFTER)"
  if (Should-Restart $gatewayFails) {
    Stop-PortOwner $GatewayPort 'gateway'
    [void](Start-Gateway)   # see the note above: no reset on spawn success
  }
}

# Heartbeat, always. Previously a healthy supervisor wrote nothing at all under
# -Once (the mode the scheduled task actually uses), so a dead task and a
# healthy one looked identical. -Status now warns when this goes stale.
Set-State $relayFails $gatewayFails
if ($relayHealthy -and $gatewayHealthy -and -not $Once) { Write-Log 'both healthy; nothing to do' }

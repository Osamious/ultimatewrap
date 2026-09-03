# Harness twin of uw-supervise.ps1, pointed at the ISOLATED ports.
#
# Exists so Stage E can test the supervisor's LOGIC — ensure-running, relay-first
# ordering, idempotence, logging — without killing the live gateway and relay,
# which would take out whatever Claude Code session is running.
#
# Deliberately mirrors the real script's structure; if they drift, this proves
# less than it appears to, so keep them in step.

[CmdletBinding()]
param([switch]$Status)

$ErrorActionPreference = 'Stop'

$RelayScript = Join-Path $HOME '.local\bin\anthropic-oauth-relay.mjs'
$RelayPort   = 44517          # scratch relay, NOT the live 4517
$GatewayPort = 39456          # isolated gateway, NOT the live 3456
$Root        = 'C:\Users\osami\.uw\harness\scratch'
$LogFile     = 'C:\Users\osami\.uw\harness\supervise-harness.log'

function Write-Log([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
  Write-Output $line
}

function Test-Listening([int]$Port) {
  try { $null = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop; return $true }
  catch { return $false }
}

function Start-Relay {
  # Same script, different port via its documented env override.
  $env:ANTHROPIC_RELAY_PORT = "$RelayPort"
  Start-Process -FilePath 'node' -ArgumentList "`"$RelayScript`"" -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (Test-Listening $RelayPort) { Write-Log "started harness relay on $RelayPort"; return $true }
  Write-Log "WARN harness relay did not come up on $RelayPort"; return $false
}

function Start-Gateway {
  # The isolated instance only exists because of these redirects; starting it
  # without them would launch a LIVE daemon, which is the thing being avoided.
  $env:CCR_INTERNAL_APP_DATA_DIR = Join-Path $Root 'appdata'
  $env:CCR_CONFIG_DIR            = Join-Path $Root 'appdata\claude-code-router'
  $env:LOCALAPPDATA              = Join-Path $Root 'localappdata'
  $env:CCR_WEB_HOST              = '127.0.0.1'
  $env:CCR_WEB_PORT              = '39458'
  $env:CCR_WEB_AUTH_TOKEN        = 'uw-harness-local-only-token'
  $ccr = @(
    (Get-Command 'ccr.cmd' -ErrorAction SilentlyContinue).Source,
    (Join-Path (Split-Path (Get-Command node).Source) 'ccr.cmd')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $ccr) { Write-Log 'ERROR ccr.cmd not on PATH'; return $false }
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
  if (Test-Listening $GatewayPort) { Write-Log "started harness gateway on $GatewayPort"; return $true }
  Write-Log "WARN harness gateway did not come up on $GatewayPort"; return $false
}

$relayUp   = Test-Listening $RelayPort
$gatewayUp = Test-Listening $GatewayPort

if ($Status) {
  "harness relay   ($RelayPort):   {0}" -f $(if ($relayUp)   { 'UP' } else { 'DOWN' })
  "harness gateway ($GatewayPort): {0}" -f $(if ($gatewayUp) { 'UP' } else { 'DOWN' })
  return
}

# Relay first: the gateway's Anthropic provider points at it, so starting the
# gateway against a dead relay yields auth failures on the first Claude request.
if (-not $relayUp)   { Start-Relay   | Out-Null }
if (-not $gatewayUp) { Start-Gateway | Out-Null }

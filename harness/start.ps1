# Starts an isolated CCR instance. Nothing here may touch live state.
#
# Isolation levers (all verified against the installed CCR 3.0.22 dist):
#   CCR_INTERNAL_APP_DATA_DIR -> CONFIGDIR (config.sqlite, service.json, bin/)
#   CCR_CONFIG_DIR            -> pins the embedded codex middleware, which
#                                otherwise reads %APPDATA% directly
#   LOCALAPPDATA              -> the Claude-desktop-app sync target (Claude-3p).
#                                REQUIRED: that sync is gated ONLY on "a provider
#                                model exists" in the shipped build. There is no
#                                surface!=="cli" gate despite the TS source.
#   CCR_WEB_HOST/PORT/AUTH_TOKEN -> management server
# Gateway ports are NOT env-driven; bootstrap.mjs rewrites them in config while
# Providers[] is still empty, so the gateway never binds a live port.

$ErrorActionPreference = 'Stop'
$root = 'C:\Users\osami\.uw\harness\scratch'
$appData = Join-Path $root 'appdata'
$localAppData = Join-Path $root 'localappdata'
$claudeConfig = Join-Path $root 'claude-config'

New-Item -ItemType Directory -Force -Path $root, $appData, $localAppData, $claudeConfig | Out-Null

# Owner-only ACL: a real provider key lands in this tree (config.sqlite, and the
# apiKeyHelper .cmd / WIF token under CONFIGDIR\bin).
icacls $root /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

$env:CCR_INTERNAL_APP_DATA_DIR = $appData
$env:CCR_CONFIG_DIR = Join-Path $appData 'claude-code-router'
$env:LOCALAPPDATA = $localAppData
$env:CCR_WEB_HOST = '127.0.0.1'
$env:CCR_WEB_PORT = '39458'
$env:CCR_WEB_AUTH_TOKEN = 'uw-harness-local-only-token'

ccr start

# Stamp the daemon so guards can reject a STALE daemon that predates this script
# and therefore lacks the redirects above. Written after start so the pid is real.
$svcPath = Join-Path $appData 'claude-code-router\service.json'
if (Test-Path $svcPath) {
  $svc = Get-Content $svcPath -Raw | ConvertFrom-Json
  @{
    pid = $svc.pid
    startedAt = (Get-Date).ToString('o')
    env = @{
      CCR_INTERNAL_APP_DATA_DIR = $env:CCR_INTERNAL_APP_DATA_DIR
      CCR_CONFIG_DIR = $env:CCR_CONFIG_DIR
      LOCALAPPDATA = $env:LOCALAPPDATA
    }
  } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $root 'daemon-env.json')
  Write-Output "stamped daemon pid $($svc.pid)"
} else {
  throw "no service.json at $svcPath - daemon did not start into the scratch CONFIGDIR"
}

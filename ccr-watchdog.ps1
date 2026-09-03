# ccr-watchdog.ps1 - Phase 1 of the UltimateWrap plan (C:\Users\osami\.omc\plans\ultimatewrap-v1.md).
#
# Polls CCR's gateway /health endpoint and, optionally, heals it with a bounded restart.
#
#   -Observe : log-only, never restarts. Run this under Phase 2's spike/validation work.
#   -Heal    : adds bounded restart-on-failure (exponential backoff, hard cap per rolling
#              window persisted to disk, then alert + exit rather than loop forever against
#              a deterministic boot-crash).
#
# Never calls CCR's own restartGateway RPC - always a full `ccr stop` + `ccr start --gateway`,
# per this project's standing rule (that RPC path was found flaky earlier in this project).
#
# Runs under both Windows PowerShell 5.1 (powershell.exe, e.g. Task Scheduler's default) and
# PowerShell 7+ (pwsh) - #requires enforces the floor; -UseBasicParsing keeps IWR working on
# a Windows 11 box with no IE engine, where 5.1's default (HTML-parsing) mode throws on every
# response, success or failure alike - a real defect caught by review, not a hypothetical one.
#
# Usage:
#   .\ccr-watchdog.ps1 -Observe
#   .\ccr-watchdog.ps1 -Heal
#   .\ccr-watchdog.ps1 -Heal -PollIntervalSeconds 15 -MaxRestartsPerWindow 3 -WindowMinutes 10

#requires -Version 5.1

param(
    [switch]$Observe,
    [switch]$Heal,
    [ValidateRange(1, 3600)][int]$PollIntervalSeconds = 20,
    [ValidateRange(1, 100)][int]$MaxRestartsPerWindow = 3,
    [ValidateRange(1, 1440)][int]$WindowMinutes = 10,
    [ValidateRange(1, 600)][int]$PostRestartGraceSeconds = 30,
    [string]$GatewayHost = "127.0.0.1",
    [string]$ConfigSqlitePath = (Join-Path $env:APPDATA "claude-code-router\config.sqlite"),
    [string]$LogPath = (Join-Path $env:USERPROFILE ".uw\watchdog.log"),
    [string]$PauseSentinelPath = (Join-Path $env:USERPROFILE ".uw\watchdog.pause"),
    [string]$RestartStatePath = (Join-Path $env:USERPROFILE ".uw\watchdog.restarts.json"),
    [string]$LockName = "Global\ccr-watchdog-heal-lock"
)

if (-not ($Observe -or $Heal)) { Write-Error "Specify -Observe or -Heal."; exit 1 }
if ($Observe -and $Heal) { Write-Error "Specify only one of -Observe or -Heal."; exit 1 }

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$logDir = Split-Path -Parent $LogPath
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# --- token redaction: ccr start/stop stdout can echo service.json's live management token
# (`?ccr_web_token=...`) -- never let that land in a plaintext, unrotated log file. ---
function Protect-LogLine([string]$Line) {
    return ($Line -replace 'ccr_web_token=[^&\s]+', 'ccr_web_token=***REDACTED***')
}

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), (Protect-LogLine $Message)
    Write-Host $line
    try {
        Add-Content -Path $LogPath -Value $line -Encoding utf8
    } catch {
        Write-Host "[watchdog] WARNING: failed to write log file ($($_.Exception.Message)); continuing without persistent logging this line."
    }
}

# --- gateway host/port/enabled come from CCR's own config, not a hardcoded guess: a routine
# config edit (e.g. changing gateway.port) would otherwise make a healthy gateway look "down"
# forever. Read fresh every poll so a live config change is picked up without a restart of
# this script. This is a local file read, not an RPC call -- no service.json/auth token
# involved. Requires python3 on PATH (already a dependency of this whole project's tooling). ---
function Get-GatewayEndpointConfig {
    # Written once to a FIXED, reused path (not a fresh GetTempFileName() per poll) so nothing
    # leaks. A prior version wrote GetTempFileName()+".py" (a different filename than the one
    # GetTempFileName() actually creates) and only cleaned up the ".py" copy, leaking one .tmp
    # file per poll (~4,300/day at the default interval) until GetTempFileName() itself started
    # throwing. An `python3 -c $py ...` inline-argument version (no file at all) was tried next
    # but produced no output in practice -- multi-line script content doesn't survive PowerShell's
    # process-argument marshaling to python3 reliably on Windows -- so this reverts to a file,
    # just a stable one instead of a fresh leak-prone one.
    $probeScriptPath = Join-Path $env:USERPROFILE ".uw\.gateway-config-probe.py"
    $py = @'
import json, sqlite3, sys
try:
    con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("select value_json from app_config where key='default'")
    row = cur.fetchone()
    if not row:
        print(json.dumps({"ok": False, "error": "no config row"}))
        sys.exit(0)
    cfg = json.loads(row[0])
    gw = cfg.get("gateway", {}) or {}
    proxy = cfg.get("proxy", {}) or {}
    print(json.dumps({
        "ok": True,
        "host": gw.get("host", "127.0.0.1"),
        "port": gw.get("port", 3456),
        "enabled": bool(gw.get("enabled", True)),
        "proxyEnabled": bool(proxy.get("enabled", False)),
        "proxyMode": proxy.get("mode", ""),
    }))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
'@
    try {
        if (-not (Test-Path $probeScriptPath) -or ((Get-Content -Path $probeScriptPath -Raw -ErrorAction SilentlyContinue) -ne $py)) {
            Set-Content -Path $probeScriptPath -Value $py -Encoding utf8
        }
        $out = & python3 $probeScriptPath $ConfigSqlitePath 2>$null
        if (-not $out) {
            Write-Log "WARNING: config read produced no output (python3 on PATH? config at $ConfigSqlitePath ?) - falling back to hardcoded host/port ${GatewayHost}:3456."
            return $null
        }
        $parsed = $out | ConvertFrom-Json
        if (-not $parsed.ok) {
            Write-Log "WARNING: config read failed ($($parsed.error)) - falling back to hardcoded host/port ${GatewayHost}:3456."
            return $null
        }
        return $parsed
    } catch {
        Write-Log "WARNING: config read threw ($($_.Exception.Message)) - falling back to hardcoded host/port ${GatewayHost}:3456."
        return $null
    }
}

# Returns one of: "Healthy", "Starting", "DisabledByConfig", "Down"
#
# /health always answers HTTP 200 when a listener exists and isn't config-gated off, even when
# the core itself has crashed -- the real signal is the response BODY's "status" field
# ("stopped" | "starting" | "running" | "error", per CCR's gateway-service.ts / contracts/app.ts).
# Checking only the HTTP status code misses a live failure.
#
# Whether a listener exists at all is a *separate* gate: gateway.enabled=false with the proxy
# off means no listener (connection refused) -- that state is detected up front from config,
# before ever probing. gateway.enabled=false with proxy.enabled+mode="gateway" leaves a real
# listener up that answers 503 {"error":{"message":"Gateway runtime is disabled."}} -- probed
# for below, with the body read via $_.ErrorDetails.Message (works on both 5.1 and 7; reading
# the raw response stream does not: 5.1's stream is already drained by Invoke-WebRequest, and
# PS7's HttpResponseMessage has no GetResponseStream method at all).
function Get-GatewayHealth {
    $cfg = Get-GatewayEndpointConfig
    if ($cfg -and (-not $cfg.enabled) -and (-not ($cfg.proxyEnabled -and $cfg.proxyMode -eq "gateway"))) {
        return "DisabledByConfig"
    }

    $resolvedHost = if ($cfg) { $cfg.host } else { $GatewayHost }
    $port = if ($cfg) { $cfg.port } else { 3456 }
    $healthUrl = "http://${resolvedHost}:$port/health"

    # When gateway.enabled=false but the proxy fallback is what's actually listening
    # (proxy.enabled + proxy.mode="gateway"), CCR's own request gate additionally requires
    # the request to carry `x-ccr-proxy-mode: gateway` before it will treat the request as
    # gateway traffic at all -- without it, a request to this listener isn't guaranteed to
    # behave like the gateway's own /health at all. Send it whenever config indicates this
    # fallback path might be in play.
    $extraHeaders = @{}
    if ($cfg -and $cfg.proxyEnabled -and $cfg.proxyMode -eq "gateway") {
        $extraHeaders["x-ccr-proxy-mode"] = "gateway"
    }

    try {
        $resp = Invoke-WebRequest -Uri $healthUrl -Method Get -Headers $extraHeaders -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -ne 200) { return "Down" }
        try {
            $status = ($resp.Content | ConvertFrom-Json).status
        } catch {
            return "Down"
        }
        switch ($status) {
            "running" { return "Healthy" }
            "starting" { return "Starting" }
            default { return "Down" }
        }
    } catch {
        $webResp = $_.Exception.Response
        $statusCode = $null
        if ($webResp) {
            try { $statusCode = [int]$webResp.StatusCode } catch { $statusCode = $null }
        }
        if ($statusCode -eq 503) {
            $body = $_.ErrorDetails.Message
            if ($body -and ($body -match "disabled")) { return "DisabledByConfig" }
            return "Down"
        }
        return "Down"
    }
}

function Test-PauseSentinel {
    return (Test-Path $PauseSentinelPath)
}

# --- restart-count window persisted to disk (not just an in-process List) so the cap survives
# this script being relaunched (Task Scheduler auto-restart, a supervisor, or the user just
# re-running it). Without this, "bounded" only held for one process's lifetime. ---
function Get-RestartTimestamps {
    # The comma operator on every return here is load-bearing, not stylistic: PowerShell
    # unrolls a returned collection onto the pipeline, so a non-empty List[datetime] without
    # it comes back as a bare DateTime/Object[], and the caller's .RemoveAll()/.Add() calls
    # then throw MethodNotFound -- a terminating error with no catch around it in the main
    # loop, which silently killed the whole watchdog (exit code 0) the moment a restart-state
    # file existed. Confirmed by execution during review, not theoretical.
    if (-not (Test-Path $RestartStatePath)) { return ,(New-Object System.Collections.Generic.List[datetime]) }
    try {
        $raw = Get-Content -Path $RestartStatePath -Raw | ConvertFrom-Json
        $list = New-Object System.Collections.Generic.List[datetime]
        foreach ($t in @($raw)) { $list.Add([datetime]$t) }
        return ,$list
    } catch {
        return ,(New-Object System.Collections.Generic.List[datetime])
    }
}

function Save-RestartTimestamps($List) {
    $List | ForEach-Object { $_.ToString("o") } | ConvertTo-Json | Set-Content -Path $RestartStatePath -Encoding utf8
}

Write-Log "ccr-watchdog starting. Mode=$(if ($Heal) { 'Heal' } else { 'Observe' }) PollIntervalSeconds=$PollIntervalSeconds MaxRestartsPerWindow=$MaxRestartsPerWindow WindowMinutes=$WindowMinutes"

# --- single-instance guard for -Heal: two concurrent healers each get their own idea of the
# cap, and one's `ccr stop` kills the gateway the other just started -- each would read the
# other's restart as a fresh failure. Not needed for -Observe (log-only, no shared side effects). ---
$mutex = $null
if ($Heal) {
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, $LockName, [ref]$createdNew)
    if (-not $createdNew) {
        Write-Log "Another -Heal instance already holds the lock ($LockName). Exiting rather than double-heal."
        exit 3
    }
}

$consecutiveStarting = 0
$maxConsecutiveStarting = 5

try {
    while ($true) {
      try {
        $paused = Test-PauseSentinel
        $health = Get-GatewayHealth

        # A gateway wedged in "starting" forever (core never binds) would otherwise be logged
        # as benign indefinitely -- inert in exactly the failure mode this script exists to
        # catch. Escalate to Down after enough consecutive polls see it, so -Heal eventually
        # acts on it instead of watching quietly forever.
        if ($health -eq "Starting") {
            $consecutiveStarting++
            if ($consecutiveStarting -ge $maxConsecutiveStarting) {
                Write-Log "Starting state persisted for $consecutiveStarting consecutive polls - treating as wedged, escalating to Down."
                $health = "Down"
                $consecutiveStarting = 0
            }
        } else {
            $consecutiveStarting = 0
        }

        switch ($health) {
            "Healthy" { Write-Log "Healthy." }
            "DisabledByConfig" { Write-Log "Gateway intentionally disabled (config) - not a failure, no action." }
            "Starting" { Write-Log "Starting (transient, $consecutiveStarting/$maxConsecutiveStarting consecutive) - not yet treated as a failure." }
            "Down" {
                Write-Log "UNHEALTHY: gateway not responding as expected."
                if ($Observe) {
                    Write-Log "Observe mode: logging only, not restarting."
                } elseif ($paused) {
                    Write-Log "Paused (sentinel file present at $PauseSentinelPath) - would normally heal, skipping the restart action only (still observing)."
                } else {
                    $now = Get-Date
                    $windowStart = $now.AddMinutes(-$WindowMinutes)
                    $restartTimestamps = Get-RestartTimestamps
                    $restartTimestamps.RemoveAll({ param($t) $t -lt $windowStart }) | Out-Null

                    if ($restartTimestamps.Count -ge $MaxRestartsPerWindow) {
                        Write-Log "ALERT: $($restartTimestamps.Count) restarts already attempted in the last $WindowMinutes minute(s) (cap=$MaxRestartsPerWindow). Not restarting again - this looks like a deterministic failure, not a transient one. Exiting so the failure surfaces instead of looping silently."
                        Save-RestartTimestamps $restartTimestamps
                        exit 2
                    }

                    $restartTimestamps.Add($now) | Out-Null
                    $attemptNum = $restartTimestamps.Count
                    Save-RestartTimestamps $restartTimestamps

                    $backoffSeconds = [Math]::Min(60, [Math]::Pow(2, $attemptNum - 1) * 2)
                    Write-Log "Recovering: attempt $attemptNum of $MaxRestartsPerWindow this window. Backoff ${backoffSeconds}s before restart."
                    Start-Sleep -Seconds $backoffSeconds

                    $restartOk = $true
                    try {
                        Write-Log "Running: ccr stop"
                        & ccr stop 2>&1 | ForEach-Object { Write-Log "  ccr stop: $_" }
                        if ($LASTEXITCODE -ne 0) { Write-Log "  ccr stop exited with code $LASTEXITCODE (continuing - stop failing when already stopped is common)." }
                        Start-Sleep -Seconds 1
                        Write-Log "Running: ccr start --gateway --no-open"
                        & ccr start --gateway --no-open 2>&1 | ForEach-Object { Write-Log "  ccr start: $_" }
                        if ($LASTEXITCODE -ne 0) {
                            Write-Log "  ccr start exited with code $LASTEXITCODE - treating this attempt as failed."
                            $restartOk = $false
                        }
                    } catch {
                        Write-Log "  ccr command threw: $($_.Exception.Message) - treating this attempt as failed (is 'ccr' on PATH?)."
                        $restartOk = $false
                    }

                    if ($restartOk) {
                        # Grace period: a booting gateway is legitimately "Down" (connection
                        # refused) or "Starting" for a few seconds after `ccr start` returns.
                        # Poll faster here so a slow-but-successful boot isn't scored as a
                        # failure just because the next full poll cycle would be too soon.
                        $graceDeadline = (Get-Date).AddSeconds($PostRestartGraceSeconds)
                        $recovered = $false
                        while ((Get-Date) -lt $graceDeadline) {
                            Start-Sleep -Seconds 2
                            $graceHealth = Get-GatewayHealth
                            if ($graceHealth -eq "Healthy") { $recovered = $true; break }
                        }
                        if ($recovered) {
                            Write-Log "Recovered: gateway reports Healthy within the ${PostRestartGraceSeconds}s post-restart grace period."
                        } else {
                            Write-Log "Restart command succeeded but gateway did not report Healthy within ${PostRestartGraceSeconds}s - will re-evaluate next cycle."
                        }
                    }
                }
            }
        }

      } catch {
        # A single poll iteration failing (a transient exception anywhere in the try above)
        # must not silently end the whole watchdog with exit code 0 -- that previously made a
        # supervisor read a crashed watchdog as a clean success. Log it and keep polling; only
        # explicit exit 2 (cap reached) and exit 3 (lock held) are intentional terminations.
        Write-Log "UNEXPECTED ERROR in poll loop: $($_.Exception.Message). Continuing to poll rather than exiting silently."
      }

        Start-Sleep -Seconds $PollIntervalSeconds
    }
} finally {
    if ($mutex) {
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}

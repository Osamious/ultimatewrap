# test-health-stub.ps1 - local stand-in for CCR's /health endpoint, used only to validate
# ccr-watchdog.ps1's classification logic against every state without depending on a real,
# potentially-flaky CCR instance.
param(
    [Parameter(Mandatory=$true)][ValidateSet("Running","Starting","Error","Disabled")]$State,
    [int]$Port = 39456
)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "stub listening on $Port, state=$State"

try {
    while ($true) {
        $ctx = $listener.GetContext()
        $resp = $ctx.Response
        if ($State -eq "Disabled") {
            $resp.StatusCode = 503
            $body = '{"error":{"message":"Gateway runtime is disabled."}}'
        } else {
            $resp.StatusCode = 200
            $statusField = switch ($State) {
                "Running" { "running" }
                "Starting" { "starting" }
                "Error" { "error" }
            }
            $body = '{"core":"http://127.0.0.1:39457","status":"' + $statusField + '","timestamp":"2026-09-01T00:00:00.000Z"}'
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $resp.ContentType = "application/json"
        $resp.ContentLength64 = $bytes.Length
        $resp.OutputStream.Write($bytes, 0, $bytes.Length)
        $resp.OutputStream.Close()
    }
} finally {
    $listener.Stop()
}

# start-studio.ps1 — サーバーを裏で起動して操作パネルを開く（Windows PowerShell 5.1 / 7）
#   powershell -ExecutionPolicy Bypass -File start-studio.ps1 [-Port 8811] [-NoBrowser]
#   止める: Stop-Process -Id (Get-Content output\server.pid)
param(
    [ValidateRange(1, 65535)][int]$Port = 8811,
    [switch]$NoBrowser,
    [string]$Python
)

$ErrorActionPreference = 'Stop'
$kitRoot = $PSScriptRoot
$studioRoot = Join-Path $kitRoot 'studio'
$studioUrl = "http://127.0.0.1:$Port"

function Get-StudioState {
    try { return Invoke-RestMethod -Uri "$studioUrl/api/state" -TimeoutSec 2 }
    catch { return $null }
}

$studioState = Get-StudioState
if ($null -eq $studioState -or $null -eq $studioState.transitionId) {
    if (-not $Python) {
        # Each probe is isolated: under Windows PowerShell 5.1 with ErrorActionPreference=Stop, a candidate that
        # writes to stderr (e.g. the Microsoft Store python.exe stub) raises a terminating error. Skip it and go on.
        foreach ($candidate in @('python', 'python3', 'py')) {
            try {
                $command = Get-Command $candidate -CommandType Application -ErrorAction Stop | Select-Object -First 1
                $previousPreference = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                try {
                    $null = & $command.Source -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>&1
                    $probeExit = $LASTEXITCODE
                } finally {
                    $ErrorActionPreference = $previousPreference
                }
                if ($probeExit -eq 0) { $Python = $command.Source; break }
            } catch {
                continue
            }
        }
    }
    if (-not $Python) { throw 'Python 3.10 or newer is required. Pass -Python C:\path\to\python.exe if needed.' }
    $serverScript = Join-Path $studioRoot 'server.py'
    $logDirectory = Join-Path $kitRoot 'output'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $serverArguments = @('-B', '-u', ('"{0}"' -f $serverScript), '--port', $Port)
    $studioProcess = Start-Process -FilePath $Python -ArgumentList $serverArguments -WorkingDirectory $studioRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'server.out.log') -RedirectStandardError (Join-Path $logDirectory 'server.err.log')
    $studioProcess.Id | Set-Content -LiteralPath (Join-Path $logDirectory 'server.pid') -Encoding ascii
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 200
        $studioState = Get-StudioState
        if ($null -ne $studioState -and $null -ne $studioState.transitionId) { break }
        if ($studioProcess.HasExited) { break }
    }
    if ($null -eq $studioState -or $null -eq $studioState.transitionId) {
        throw "Studio did not start. See $logDirectory\server.err.log (the port may already be occupied)."
    }
}

Write-Host "Studio:     $studioUrl/"
Write-Host "Control:    $studioUrl/control.html"
Write-Host "OBS source: $studioUrl/?output=1  (1920 x 1080)"
if (-not $NoBrowser) { Start-Process -FilePath "$studioUrl/control.html" }

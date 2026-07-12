[CmdletBinding()]
param(
    [string] $HealthUrl = "http://127.0.0.1:8787/health",
    [int] $WorkerTimeoutSeconds = 30,
    [switch] $SkipWorkerSmoke,
    [switch] $MockWorkerSmoke
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$summaryPath = Join-Path $repoRoot ".agents\summary.ps1"
$taskPath = Join-Path $repoRoot ".agents\claude-task.ps1"
$ledgerPath = Join-Path $repoRoot ".agents\ledger.ps1"

function New-Check {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][bool] $Ok,
        [string] $Detail = ""
    )
    [pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail }
}

$healthChecks = [System.Collections.Generic.List[object]]::new()
$summaryChecks = [System.Collections.Generic.List[object]]::new()
$ledgerChecks = [System.Collections.Generic.List[object]]::new()
$workerSmokeChecks = [System.Collections.Generic.List[object]]::new()

try {
    $health = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 10
    $healthChecks.Add((New-Check "/health" ([bool]$health.ok) "ok=$($health.ok)"))
} catch {
    $healthChecks.Add((New-Check "/health" $false $_.Exception.Message))
}

try {
    $summaryOutput = & powershell -NoProfile -File $summaryPath -RunId latest -IncludeIncomplete 2>&1 | Out-String
    $summaryChecks.Add((New-Check "summary.ps1" ($LASTEXITCODE -eq 0) (($summaryOutput -split "`r?`n" | Select-Object -First 1) -join "")))
} catch {
    $summaryChecks.Add((New-Check "summary.ps1" $false $_.Exception.Message))
}

try {
    $ledgerOutput = & powershell -NoProfile -File $ledgerPath -Tail 3 -Json 2>&1 | Out-String
    $ledgerChecks.Add((New-Check "ledger.ps1" ($LASTEXITCODE -eq 0) (($ledgerOutput -split "`r?`n" | Select-Object -First 1) -join "")))
} catch {
    $ledgerChecks.Add((New-Check "ledger.ps1" $false $_.Exception.Message))
}

if ($SkipWorkerSmoke) {
    $workerSmokeChecks.Add((New-Check "claude-task.ps1 plan" $true "Skipped by -SkipWorkerSmoke."))
} else {
    try {
        $taskArgs = @("plan", "-Task", "Return exactly OK and nothing else.", "-WorkerTimeoutSeconds", $WorkerTimeoutSeconds)
        if ($MockWorkerSmoke) { $taskArgs += "-MockWorker" }
        $null = & powershell -NoProfile -File $taskPath @taskArgs 2>&1 | Out-String
        $planExitCode = $LASTEXITCODE
        $planSummary = & powershell -NoProfile -File $summaryPath -RunId latest -IncludeIncomplete 2>&1 | Out-String
        $summaryExitCode = $LASTEXITCODE
        $keyLines = @($planSummary -split "`r?`n" | Where-Object {
            $_ -match '^(Status|Mode|Summary|Error|Blocked|RunId|Run directory):'
        })
        $hasSuccess = @($keyLines | Where-Object { $_ -match '^Status:\s+success\s*$' }).Count -gt 0
        $hasPlanMode = @($keyLines | Where-Object { $_ -match '^Mode:\s+plan\s*$' }).Count -gt 0
        $hasFailure = $planSummary -match 'worker_failed|worker_timeout|incomplete'
        $planOk = ($planExitCode -eq 0) -and ($summaryExitCode -eq 0) -and $hasSuccess -and $hasPlanMode -and (-not $hasFailure)
        $detail = if ($keyLines.Count -gt 0) { $keyLines -join " | " } else { "No summary key lines found." }
        $workerSmokeChecks.Add((New-Check "claude-task.ps1 plan" $planOk $detail))
    } catch {
        $workerSmokeChecks.Add((New-Check "claude-task.ps1 plan" $false $_.Exception.Message))
    }
}

$allChecks = @($healthChecks) + @($summaryChecks) + @($ledgerChecks) + @($workerSmokeChecks)
$ok = -not ($allChecks | Where-Object { -not $_.ok })
[pscustomobject]@{
    ok = $ok
    workerTimeoutSeconds = $WorkerTimeoutSeconds
    skipWorkerSmoke = [bool]$SkipWorkerSmoke
    mockWorkerSmoke = [bool]$MockWorkerSmoke
    health = $healthChecks
    summary = $summaryChecks
    ledger = $ledgerChecks
    workerSmoke = $workerSmokeChecks
} | ConvertTo-Json -Depth 6

if (-not $ok) { exit 1 }

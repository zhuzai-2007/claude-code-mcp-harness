[CmdletBinding()]
param(
    [string] $ProjectRoot = (Get-Location).Path,
    [switch] $MockWorker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$doctor = Join-Path $ProjectRoot ".agents\doctor.ps1"
$task = Join-Path $ProjectRoot ".agents\claude-task.ps1"
$summary = Join-Path $ProjectRoot ".agents\summary.ps1"
$ledger = Join-Path $ProjectRoot ".agents\ledger.ps1"

foreach ($path in @($doctor, $task, $summary, $ledger)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing harness script: $path" }
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $doctor
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$args = @("plan", "-Task", "Return JSON with summary exactly ok.", "-WorkerTimeoutSeconds", "60")
if ($MockWorker) { $args += "-MockWorker" }
& powershell -NoProfile -ExecutionPolicy Bypass -File $task @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& powershell -NoProfile -ExecutionPolicy Bypass -File $summary -RunId latest -IncludeIncomplete
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& powershell -NoProfile -ExecutionPolicy Bypass -File $ledger -Tail 3

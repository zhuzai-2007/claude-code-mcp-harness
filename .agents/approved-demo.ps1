[CmdletBinding()]
param(
    [int] $WorkerTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FullPath { param([string] $Path) return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path) }
function Get-RelativePathCompat {
    param([string] $Root, [string] $Path)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    return [System.IO.Path]::GetFullPath($Path).Substring($rootFull.Length + 1)
}
function Get-RunDirs {
    param([string] $ProjectRoot, [string] $AgentsRoot)
    $roots = @((Join-Path $AgentsRoot 'runs'), (Join-Path $ProjectRoot '.agent-runs'))
    $dirs = @()
    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
            $dirs += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
        }
    }
    return @($dirs)
}
function Read-WorkerResult {
    param([string] $RunDir)
    $normalized = Join-Path $RunDir 'worker-result.normalized.json'
    $result = Join-Path $RunDir 'result.json'
    if (Test-Path -LiteralPath $normalized) { return Get-Content -LiteralPath $normalized -Raw | ConvertFrom-Json }
    if (Test-Path -LiteralPath $result) { return Get-Content -LiteralPath $result -Raw | ConvertFrom-Json }
    return [pscustomobject]@{ status = 'incomplete'; summary = 'Run did not write a completed result.'; changes_made = @(); commands_run = @(); risks = @('missing result'); blocked_on = @(); error = @{ code = 'missing_result'; message = 'No result.json or worker-result.normalized.json.' } }
}
function New-Snapshot {
    param([string] $ProjectRoot)
    $exclude = @('^\.agent-runs(\\|$)', '^\.agents\\runs(\\|$)')
    $items = Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -Force | Where-Object {
        $rel = Get-RelativePathCompat -Root $ProjectRoot -Path $_.FullName
        -not ($exclude | Where-Object { $rel -match $_ })
    }
    $files = foreach ($item in ($items | Sort-Object FullName)) {
        $rel = Get-RelativePathCompat -Root $ProjectRoot -Path $item.FullName
        [ordered]@{ path = $rel; hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
    }
    return @($files)
}
function Compare-Snapshots {
    param($Before, $After)
    $beforeMap = @{}; foreach ($f in $Before) { $beforeMap[$f.path] = $f.hash }
    $afterMap = @{}; foreach ($f in $After) { $afterMap[$f.path] = $f.hash }
    $all = @($beforeMap.Keys + $afterMap.Keys | Sort-Object -Unique)
    foreach ($path in $all) {
        $b = if ($beforeMap.ContainsKey($path)) { $beforeMap[$path] } else { $null }
        $a = if ($afterMap.ContainsKey($path)) { $afterMap[$path] } else { $null }
        if ($b -ne $a) {
            [ordered]@{ path = $path; kind = if ($null -eq $b) { 'added' } elseif ($null -eq $a) { 'deleted' } else { 'modified' }; before = $b; after = $a }
        }
    }
}

$agentsRoot = Resolve-FullPath $PSScriptRoot
$projectRoot = Resolve-FullPath (Join-Path $agentsRoot '..')
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
$reportDir = Join-Path $projectRoot ".agent-runs\approved-demo-$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$runDirsBefore = @(Get-RunDirs -ProjectRoot $projectRoot -AgentsRoot $agentsRoot)
$before = New-Snapshot -ProjectRoot $projectRoot
$task = 'Create exactly these two project-local files and modify nothing else: 1. Write one line to workspace/demo-approved.txt: hello from approved claude worker 2. Write a very short report to outbox/report.md saying the demo run is complete. Do not modify any other files.'
$workerScript = Join-Path $agentsRoot 'claude-task.ps1'
& $workerScript run -Task $task -ApprovedBy Codex -ApprovalReason 'approved demo run for harness validation' -WorkerTimeoutSeconds $WorkerTimeoutSeconds
$workerExit = $LASTEXITCODE
$runDirsAfter = @(Get-RunDirs -ProjectRoot $projectRoot -AgentsRoot $agentsRoot)
$newRunDirs = @($runDirsAfter | Where-Object { $runDirsBefore -notcontains $_ } | Sort-Object -Descending)
$workerRunDir = if ($newRunDirs.Count -gt 0) { $newRunDirs[0] } else { $null }
$workerResult = if ($workerRunDir) { Read-WorkerResult -RunDir $workerRunDir } else { [pscustomobject]@{ status = 'missing'; summary = 'No new worker run directory was detected.'; changes_made = @(); commands_run = @(); risks = @('missing run directory'); blocked_on = @(); error = @{ code = 'missing_run'; message = 'No new worker run directory was detected.' } } }
$after = New-Snapshot -ProjectRoot $projectRoot
$diff = @(Compare-Snapshots -Before $before -After $after)
$allowed = @('workspace\demo-approved.txt', 'outbox\report.md')
$unexpected = @($diff | Where-Object { $allowed -notcontains $_.path })
$demoFile = Join-Path $projectRoot 'workspace\demo-approved.txt'
$reportFile = Join-Path $projectRoot 'outbox\report.md'
$demoOk = (Test-Path -LiteralPath $demoFile) -and ((Get-Content -LiteralPath $demoFile -Raw).Trim() -eq 'hello from approved claude worker')
$reportOk = (Test-Path -LiteralPath $reportFile) -and -not [string]::IsNullOrWhiteSpace((Get-Content -LiteralPath $reportFile -Raw))
$passed = ($workerExit -eq 0) -and ($workerResult.status -eq 'success') -and $demoOk -and $reportOk -and ($unexpected.Count -eq 0)
$result = [ordered]@{
    passed = $passed
    workerExitCode = $workerExit
    workerRunDir = $workerRunDir
    workerStatus = $workerResult.status
    workerSummary = $workerResult.summary
    demoFileOk = $demoOk
    reportFileOk = $reportOk
    changedFiles = @($diff)
    unexpectedChanges = @($unexpected)
    workerResult = $workerResult
}
$jsonPath = Join-Path $reportDir 'approved-demo-report.json'
$mdPath = Join-Path $reportDir 'approved-demo-report.md'
$result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
@"
# Approved Demo Report

- Passed: $passed
- Worker exit code: $workerExit
- Worker run dir: $workerRunDir
- Worker status: $($workerResult.status)
- Worker summary: $($workerResult.summary)
- Demo file OK: $demoOk
- Report file OK: $reportOk
- Unexpected changes: $($unexpected.Count)
"@ | Set-Content -LiteralPath $mdPath -Encoding UTF8
Write-Host "Approved demo report: $mdPath"
if ($passed) { exit 0 } else { exit 1 }

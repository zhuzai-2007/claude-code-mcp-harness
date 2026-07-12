[CmdletBinding()]
param(
    [string] $RunId = 'latest',
    [switch] $Json,
    [switch] $IncludeIncomplete,
    [int] $Keep = 0,
    [switch] $Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Resolve-FullPath { param([string] $Path) return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path) }
function Get-RunDirs {
    param([string[]] $Roots, [bool] $IncludeIncomplete)
    $dirs = @()
    foreach ($root in $Roots) {
        if (Test-Path -LiteralPath $root) {
            $dirs += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object {
                $hasResult = Test-Path -LiteralPath (Join-Path $_.FullName 'result.json')
                $hasMeta = Test-Path -LiteralPath (Join-Path $_.FullName 'meta.json')
                return ($hasResult -or ($IncludeIncomplete -and $hasMeta))
            }
        }
    }
    return @($dirs | Sort-Object Name -Descending)
}
function Read-RunResult {
    param([string] $RunDir)
    $normalizedPath = Join-Path $RunDir 'worker-result.normalized.json'
    $resultPath = Join-Path $RunDir 'result.json'
    if (Test-Path -LiteralPath $normalizedPath) { return Get-Content -LiteralPath $normalizedPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    if (Test-Path -LiteralPath $resultPath) { return Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    $metaPath = Join-Path $RunDir 'meta.json'
    $inProgressPath = Join-Path $RunDir 'in_progress.json'
    $meta = if (Test-Path -LiteralPath $metaPath) { Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{
        status = 'incomplete'
        mode = if ($meta -and $meta.mode) { $meta.mode } else { $null }
        summary = 'Run has no result.json or worker-result.normalized.json.'
        files_read = @()
        changes_made = @()
        commands_run = @()
        tests_or_checks = @()
        risks = @('Run may have been interrupted before completion.')
        blocked_on = @()
        cost = $null
        artifacts = @{ run_dir = $RunDir; meta = $metaPath; in_progress = $inProgressPath }
        error = @{ code = 'missing_result'; message = 'Run directory exists but no completed result was written.' }
    }
}

$agentsRoot = Resolve-FullPath $PSScriptRoot
$projectRoot = Resolve-FullPath (Join-Path $agentsRoot '..')
$roots = @((Join-Path $agentsRoot 'runs'), (Join-Path $projectRoot '.agent-runs'))
$runs = Get-RunDirs -Roots $roots -IncludeIncomplete ([bool]$IncludeIncomplete)

if ($Clean) {
    if ($Keep -lt 1) { throw '-Clean requires -Keep 1 or higher.' }
    $delete = @($runs | Select-Object -Skip $Keep)
    foreach ($dir in $delete) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
    Write-Host "Deleted $($delete.Count) old run directories. Kept $Keep."
    exit 0
}

if ($runs.Count -eq 0) { throw 'No worker runs found.' }
$run = if ($RunId -eq 'latest') { $runs[0] } else { $runs | Where-Object { $_.Name -eq $RunId } | Select-Object -First 1 }
if (-not $run) { throw "Run not found: $RunId" }
$result = Read-RunResult -RunDir $run.FullName
if ($Json) { $result | ConvertTo-Json -Depth 8; exit 0 }
Write-Host "Run: $($run.Name)"
Write-Host "Status: $($result.status)"
Write-Host "Mode: $($result.mode)"
Write-Host "Summary: $($result.summary)"
if ($result.blocked_on -and $result.blocked_on.Count -gt 0) { Write-Host "Blocked on: $($result.blocked_on -join '; ')" }
if ($result.changes_made -and $result.changes_made.Count -gt 0) { Write-Host "Changes: $($result.changes_made -join '; ')" }
if ($result.error) { Write-Host "Error: $($result.error.code) $($result.error.message)" }
Write-Host "Run dir: $($run.FullName)"


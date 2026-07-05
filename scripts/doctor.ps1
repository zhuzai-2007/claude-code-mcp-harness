[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repoRoot "mcp-server"
$packagePath = Join-Path $serverDir "package.json"
$configPath = Join-Path $serverDir "config.json"

function New-Check {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][bool] $Ok,
        [string] $Detail = ""
    )
    [pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail }
}

function Invoke-VersionCheck {
    param(
        [Parameter(Mandatory = $true)][string] $Command,
        [string[]] $Arguments = @("--version"),
        [int] $TimeoutSeconds = 15
    )
    $cmd = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $cmd) {
        return New-Check $Command $false "Command not found."
    }

    $job = Start-Job -ScriptBlock {
        param($Exe, $Args)
        & $Exe @Args 2>&1 | Out-String
        return $LASTEXITCODE
    } -ArgumentList $cmd.Source, $Arguments

    if (-not (Wait-Job -Job $job -Timeout $TimeoutSeconds)) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        return New-Check $Command $false "Command timed out after $TimeoutSeconds seconds."
    }

    $output = Receive-Job -Job $job -ErrorAction SilentlyContinue | Out-String
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    $firstLine = (($output -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
    return New-Check $Command $true $firstLine
}

$checks = [System.Collections.Generic.List[object]]::new()
$checks.Add((Invoke-VersionCheck "node"))
$checks.Add((Invoke-VersionCheck "npm"))
$checks.Add((New-Check "mcp-server/package.json" (Test-Path -LiteralPath $packagePath) $packagePath))
$checks.Add((New-Check "mcp-server/config.json" (Test-Path -LiteralPath $configPath) $configPath))

$projectRoot = $null
if (Test-Path -LiteralPath $configPath) {
    try {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $projectRoot = [System.IO.Path]::GetFullPath([string]$config.projectRoot)
        $checks.Add((New-Check "projectRoot" (Test-Path -LiteralPath $projectRoot) $projectRoot))
    } catch {
        $checks.Add((New-Check "projectRoot" $false $_.Exception.Message))
    }
} else {
    $checks.Add((New-Check "projectRoot" $false "config.json is missing. Run scripts/init-config.ps1 first."))
}

if (-not $projectRoot) {
    $projectRoot = $repoRoot
}

$claudeTask = Join-Path $projectRoot ".agents\claude-task.ps1"
$summary = Join-Path $projectRoot ".agents\summary.ps1"
$checks.Add((New-Check ".agents/claude-task.ps1" (Test-Path -LiteralPath $claudeTask) $claudeTask))
$checks.Add((New-Check ".agents/summary.ps1" (Test-Path -LiteralPath $summary) $summary))
$checks.Add((Invoke-VersionCheck "claude"))

$ok = -not ($checks | Where-Object { -not $_.ok })
$result = [pscustomobject]@{
    ok = $ok
    repoRoot = $repoRoot
    checks = $checks
}

$result | ConvertTo-Json -Depth 6
if (-not $ok) { exit 1 }

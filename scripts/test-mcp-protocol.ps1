[CmdletBinding()]
param(
    [int] $StartupTimeoutSeconds = 60,
    [switch] $RealPlan,
    [switch] $RealWrite,
    [switch] $RealWorker,
    [ValidateRange(0.01, 5.00)]
    [decimal] $MaxBudgetUsd = 0.20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repoRoot 'mcp-server'
$configPath = Join-Path $serverDir 'config.json'
$server = $null

if (-not (Test-Path -LiteralPath $configPath)) {
    & (Join-Path $PSScriptRoot 'init-config.ps1') -ProjectRoot $repoRoot
}

try {
    $existingHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 1
    if ($existingHealth.ok) { throw 'Port 8787 already hosts an MCP bridge. Stop it before running the isolated protocol smoke.' }
} catch {
    if ($_.Exception.Message -like 'Port 8787 already hosts*') { throw }
}

try {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = '.\server.mjs'
    $startInfo.WorkingDirectory = $serverDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $server = [System.Diagnostics.Process]::Start($startInfo)
    $ready = $false
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 1
            if ($health.ok) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        $exitDetail = if ($server.HasExited) { "Server exit code: $($server.ExitCode)." } else { 'Server process is still running.' }
        throw "MCP bridge did not become ready within $StartupTimeoutSeconds seconds. $exitDetail"
    }

    Push-Location $serverDir
    try {
        $previousRealPlan = $env:MCP_REAL_PLAN
        $previousRealWrite = $env:MCP_REAL_WRITE
        $previousMaxBudget = $env:MCP_MAX_BUDGET_USD
        try {
            $env:MCP_REAL_PLAN = if ($RealPlan -or $RealWorker) { '1' } else { '0' }
            $env:MCP_REAL_WRITE = if ($RealWrite) { '1' } else { '0' }
            $env:MCP_MAX_BUDGET_USD = ([string]$MaxBudgetUsd)
            & node '.\smoke-client.mjs'
            if ($LASTEXITCODE -ne 0) { throw "MCP protocol smoke failed with exit code $LASTEXITCODE." }
        } finally {
            $env:MCP_REAL_PLAN = $previousRealPlan
            $env:MCP_REAL_WRITE = $previousRealWrite
            $env:MCP_MAX_BUDGET_USD = $previousMaxBudget
        }
    } finally {
        Pop-Location
    }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}

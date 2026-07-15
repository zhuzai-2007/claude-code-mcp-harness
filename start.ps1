[CmdletBinding()]
param(
    [switch] $SkipDoctor,
    [switch] $OpenDashboard,
    [switch] $CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$configPath = Join-Path $repoRoot "mcp-server\config.json"
$serverPath = Join-Path $repoRoot "mcp-server\server.mjs"
$nodeModules = Join-Path $repoRoot "mcp-server\node_modules"

if (-not (Test-Path -LiteralPath $configPath)) {
    & (Join-Path $repoRoot "scripts\init-config.ps1") -ProjectRoot $repoRoot
}
if (-not (Test-Path -LiteralPath $nodeModules)) {
    throw "MCP dependencies are missing. Run .\install.ps1 first."
}
if (-not $SkipDoctor) {
    & (Join-Path $repoRoot "scripts\doctor.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Doctor found required setup problems." }
}

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$hostName = if ($config.host) { [string]$config.host } else { "127.0.0.1" }
$port = if ($config.port) { [int]$config.port } else { 8787 }
$baseUrl = "http://${hostName}:${port}"
$dashboardUrl = "$baseUrl/supervisor/"

Write-Host ""
Write-Host "Supervisor v0.7 RC" -ForegroundColor Cyan
Write-Host "Dashboard: $dashboardUrl" -ForegroundColor Green
Write-Host "MCP endpoint: $baseUrl/mcp"
Write-Host "Workspace: $($config.projectRoot)"
Write-Host ""
Write-Host "Safety: planning is read-only; write stages wait for explicit approval." -ForegroundColor Yellow
Write-Host "Keep this terminal open. Press Ctrl+C to stop the local runtime."
Write-Host ""

if ($CheckOnly) {
    Write-Host "Startup check passed; server was not started." -ForegroundColor Green
    exit 0
}

if ($OpenDashboard) {
    Start-Process $dashboardUrl
}

Push-Location (Join-Path $repoRoot "mcp-server")
try {
    & node $serverPath
    exit $LASTEXITCODE
} finally {
    Pop-Location
}

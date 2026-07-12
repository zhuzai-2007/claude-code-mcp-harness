[CmdletBinding()]
param(
    [string] $ProjectRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repoRoot "mcp-server"
$examplePath = Join-Path $serverDir "config.example.json"
$configPath = Join-Path $serverDir "config.json"

if (Test-Path -LiteralPath $configPath) {
    Write-Host "config.json already exists; leaving it unchanged."
    Write-Host $configPath
    exit 0
}

if (-not (Test-Path -LiteralPath $examplePath)) {
    throw "Missing config example: $examplePath"
}

$resolvedProjectRoot = if ($ProjectRoot) {
    [System.IO.Path]::GetFullPath($ProjectRoot)
} else {
    [System.IO.Path]::GetFullPath($repoRoot)
}

$config = Get-Content -LiteralPath $examplePath -Raw -Encoding UTF8 | ConvertFrom-Json
$config.projectRoot = $resolvedProjectRoot.Replace("\", "/")
$json = $config | ConvertTo-Json -Depth 8
Set-Content -LiteralPath $configPath -Value $json -Encoding UTF8

Write-Host "Created local config:"
Write-Host $configPath

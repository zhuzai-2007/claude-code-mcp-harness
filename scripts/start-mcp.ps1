[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

Write-Host "Starting MCP bridge at http://127.0.0.1:8787/mcp"
Write-Host "This process stays in the foreground. Press Ctrl+C to stop it."
& node ".\mcp-server\server.mjs"

[CmdletBinding()]
param([switch] $SkipDoctor)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Write-Warning "scripts\start-mcp.ps1 is retained for compatibility. New users should run .\start.ps1."
& (Join-Path $repoRoot "start.ps1") -SkipDoctor:$SkipDoctor
exit $LASTEXITCODE

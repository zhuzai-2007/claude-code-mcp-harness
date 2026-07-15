[CmdletBinding()]
param(
    [string] $TargetProject,
    [switch] $Force,
    [switch] $SkipDependencies
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FullPathExistingOrParent {
    param([string] $Path)
    if (Test-Path -LiteralPath $Path) { return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path) }
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { throw "Parent directory does not exist: $parent" }
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

$sourceProject = [System.IO.Path]::GetFullPath($PSScriptRoot)
$sourceAgents = Join-Path $sourceProject '.agents'
if (-not (Test-Path -LiteralPath $sourceAgents)) { throw "Source .agents directory not found: $sourceAgents" }
$effectiveTarget = if ([string]::IsNullOrWhiteSpace($TargetProject)) { $sourceProject } else { $TargetProject }
$targetRoot = Resolve-FullPathExistingOrParent $effectiveTarget

if ($targetRoot.TrimEnd('\') -eq $sourceProject.TrimEnd('\')) {
    Write-Host "Setting up Supervisor v0.7 RC in: $sourceProject" -ForegroundColor Cyan
    & (Join-Path $sourceProject 'scripts\init-config.ps1') -ProjectRoot $sourceProject
    if (-not $SkipDependencies) {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm was not found. Install Node.js 20 or newer, reopen PowerShell, and run .\install.ps1 again." }
        Write-Host "Installing locked MCP dependencies..."
        & npm ci --prefix (Join-Path $sourceProject 'mcp-server')
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE. Check command-line network/proxy settings and retry." }
    }
    Write-Host ""
    Write-Host "Setup complete." -ForegroundColor Green
    Write-Host "Next:"
    Write-Host "  1. .\scripts\doctor.ps1"
    Write-Host "  2. .\start.ps1"
    Write-Host "  3. Open the Dashboard URL printed by start.ps1"
    exit 0
}

$targetAgents = Join-Path $targetRoot '.agents'
New-Item -ItemType Directory -Force -Path $targetAgents | Out-Null

$portableFiles = @('claude-task.ps1', 'doctor.ps1', 'summary.ps1', 'ledger.ps1', 'approved-demo.ps1', 'README.md', '.gitignore')
foreach ($file in $portableFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceAgents $file) -Destination (Join-Path $targetAgents $file) -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $targetAgents 'tests') | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceAgents 'tests\smoke.ps1') -Destination (Join-Path $targetAgents 'tests\smoke.ps1') -Force
$sourceFixtures = Join-Path $sourceAgents 'tests\fixtures'
if (Test-Path -LiteralPath $sourceFixtures) {
    Copy-Item -LiteralPath $sourceFixtures -Destination (Join-Path $targetAgents 'tests\fixtures') -Recurse -Force
}

$targetPolicy = Join-Path $targetAgents 'policy.json'
if ($Force -or -not (Test-Path -LiteralPath $targetPolicy)) {
    Copy-Item -LiteralPath (Join-Path $sourceAgents 'policy.json') -Destination $targetPolicy -Force
}
$targetResourceProfiles = Join-Path $targetAgents 'resource-profiles.json'
if ($Force -or -not (Test-Path -LiteralPath $targetResourceProfiles)) {
    Copy-Item -LiteralPath (Join-Path $sourceAgents 'resource-profiles.json') -Destination $targetResourceProfiles -Force
}
$targetWorkflowDefinitions = Join-Path $targetAgents 'workflow-definitions.json'
if ($Force -or -not (Test-Path -LiteralPath $targetWorkflowDefinitions)) {
    Copy-Item -LiteralPath (Join-Path $sourceAgents 'workflow-definitions.json') -Destination $targetWorkflowDefinitions -Force
}

$targetRuns = Join-Path $targetAgents 'runs'
New-Item -ItemType Directory -Force -Path $targetRuns | Out-Null
Set-Content -LiteralPath (Join-Path $targetRuns '.gitkeep') -Value '' -Encoding UTF8
$localConfig = Join-Path $targetAgents 'local.config.json'
if (-not (Test-Path -LiteralPath $localConfig)) {
    $configText = "{`n  `"schemaVersion`": 1,`n  `"notes`": `"Project-local overrides can be added here. This file is ignored by the portable template.`"`n}"
    Set-Content -LiteralPath $localConfig -Value $configText -Encoding UTF8
}
Write-Host "Installed worker harness to: $targetAgents"
Write-Host "Run the target project's .agents\doctor.ps1 before the first real Worker task."

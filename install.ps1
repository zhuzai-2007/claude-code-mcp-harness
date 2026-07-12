[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $TargetProject,
    [switch] $Force
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
$targetRoot = Resolve-FullPathExistingOrParent $TargetProject
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

$targetRuns = Join-Path $targetAgents 'runs'
New-Item -ItemType Directory -Force -Path $targetRuns | Out-Null
Set-Content -LiteralPath (Join-Path $targetRuns '.gitkeep') -Value '' -Encoding UTF8
$localConfig = Join-Path $targetAgents 'local.config.json'
if (-not (Test-Path -LiteralPath $localConfig)) {
    $configText = "{`n  `"schemaVersion`": 1,`n  `"notes`": `"Project-local overrides can be added here. This file is ignored by the portable template.`"`n}"
    Set-Content -LiteralPath $localConfig -Value $configText -Encoding UTF8
}
Write-Host "Installed worker harness to: $targetAgents"

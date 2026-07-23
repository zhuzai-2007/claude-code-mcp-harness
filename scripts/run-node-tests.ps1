[CmdletBinding()]
param(
    [switch] $ListOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$selector = Join-Path $PSScriptRoot "test-discovery.mjs"

$visibleFiles = @(& git -C $repoRoot ls-files --cached --others --exclude-standard -- runtime mcp-server scripts workspace)
if ($LASTEXITCODE -ne 0) { throw "Unable to enumerate Git-visible test files." }
$testFiles = @($visibleFiles | & node $selector)
if ($LASTEXITCODE -ne 0) { throw "Test discovery failed." }
$testFiles = @($testFiles | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($testFiles.Count -eq 0) { throw "No Node.js test files were discovered." }

if ($ListOnly) {
    $testFiles
    exit 0
}

Write-Host "Discovered $($testFiles.Count) Node.js test files." -ForegroundColor Cyan
$failures = [System.Collections.Generic.List[string]]::new()
foreach ($relativePath in $testFiles) {
    Write-Host "TEST $relativePath" -ForegroundColor DarkCyan
    & node (Join-Path $repoRoot $relativePath)
    if ($LASTEXITCODE -ne 0) { [void]$failures.Add($relativePath) }
}

if ($failures.Count) {
    Write-Error "$($failures.Count) test file(s) failed: $($failures -join ', ')"
    exit 1
}
Write-Host "All $($testFiles.Count) discovered Node.js test files passed." -ForegroundColor Green

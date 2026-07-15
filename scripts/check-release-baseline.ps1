[CmdletBinding()]
param(
    [switch] $SkipGitClean,
    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check([string] $Name, [bool] $Ok, [string] $Detail) {
    [void]$checks.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
}

$required = @(
    ".agents\projects.json",
    ".agents\resource-profiles.json",
    ".agents\workflow-definitions.json",
    "runtime\supervisor-decision.mjs",
    "runtime\project-context.mjs",
    "runtime\workflow-runtime.mjs",
    "workspace\supervisor-dashboard\index.html",
    "mcp-server\config.example.json"
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repoRoot $_)) })
Add-Check "Required product files" ($missing.Count -eq 0) $(if ($missing.Count) { "Missing: $($missing -join ', ')" } else { "All required v0.7 RC files are present." })

$package = Get-Content -LiteralPath (Join-Path $repoRoot "mcp-server\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Check "Release version" ([string]$package.version -eq "0.7.0-rc.1") "mcp-server package version is $($package.version)."

$lockPath = Join-Path $repoRoot "mcp-server\package-lock.json"
# Windows PowerShell 5.1 rejects the empty-string property used by npm lockfile v3.
# Extract the two audited version fields without parsing unrelated lockfile keys.
$lockRaw = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8
$topVersionMatch = [regex]::Match($lockRaw, '(?m)^\s{2}"version"\s*:\s*"([^"]+)"')
$rootPackageVersionMatch = [regex]::Match($lockRaw, '(?ms)"packages"\s*:\s*\{\s*""\s*:\s*\{.*?"version"\s*:\s*"([^"]+)"')
$lockVersionMatches = $topVersionMatch.Success -and $rootPackageVersionMatch.Success
$lockVersionsMatchPackage = $lockVersionMatches -and $topVersionMatch.Groups[1].Value -eq [string]$package.version -and $rootPackageVersionMatch.Groups[1].Value -eq [string]$package.version
Add-Check "Lockfile version" $lockVersionsMatchPackage "package.json and package-lock.json version metadata match."

$registry = Get-Content -LiteralPath (Join-Path $repoRoot ".agents\projects.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$invalidProjects = @($registry.projects | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.id) -or [string]::IsNullOrWhiteSpace([string]$_.description) -or @($_.techStack).Count -eq 0 -or @($_.aliases).Count -eq 0 -or @($_.defaultConstraints).Count -eq 0 })
Add-Check "Project context schema" ([int]$registry.schemaVersion -ge 2 -and $invalidProjects.Count -eq 0) $(if ($invalidProjects.Count) { "Projects missing description, techStack, aliases, or defaultConstraints: $($invalidProjects.id -join ', ')" } else { "$(@($registry.projects).Count) registered projects satisfy schema v$($registry.schemaVersion)." })

$readme = Get-Content -LiteralPath (Join-Path $repoRoot "README.md") -Raw -Encoding UTF8
$flowMarkers = @("Clone the repository", ".\install.ps1", ".\scripts\doctor.ps1", ".\start.ps1", "/supervisor/")
$missingFlow = @($flowMarkers | Where-Object { -not $readme.Contains($_) })
Add-Check "Operator quick start" ($missingFlow.Count -eq 0) $(if ($missingFlow.Count) { "README is missing: $($missingFlow -join ', ')" } else { "README documents clone/install/doctor/start/Dashboard usage." })

$tracked = @(& git -C $repoRoot ls-files)
$forbidden = @($tracked | Where-Object { $_ -match '(^|/)(config\.json|runtime-data|\.agents/runs|\.agent-runs)(/|$)' -or $_ -match '\.(bak|log)$|\.working-' })
Add-Check "Tracked runtime hygiene" ($forbidden.Count -eq 0) $(if ($forbidden.Count) { "Forbidden tracked files: $($forbidden -join ', ')" } else { "No local config, runtime data, backup, or log files are tracked." })

if (-not $SkipGitClean) {
    $dirty = @(& git -C $repoRoot status --porcelain --untracked-files=all)
    Add-Check "Clean Git baseline" ($dirty.Count -eq 0) $(if ($dirty.Count) { "$($dirty.Count) changed or untracked paths remain." } else { "Working tree is clean." })
}

$ok = @($checks | Where-Object { -not $_.ok }).Count -eq 0
$result = [pscustomobject]@{ ok = $ok; version = [string]$package.version; checks = $checks }
if ($Json) { $result | ConvertTo-Json -Depth 6 }
else {
    Write-Host "Supervisor release baseline" -ForegroundColor Cyan
    foreach ($check in $checks) {
        Write-Host ("{0} {1}: {2}" -f $(if ($check.ok) { "[OK]" } else { "[FAIL]" }), $check.name, $check.detail) -ForegroundColor $(if ($check.ok) { "Green" } else { "Red" })
    }
}
if (-not $ok) { exit 1 }

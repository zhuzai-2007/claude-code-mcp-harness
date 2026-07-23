[CmdletBinding()]
param(
    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$registryPath = Join-Path $repoRoot ".agents\projects.json"
$localRegistryPath = Join-Path $repoRoot ".agents\projects.local.json"
$localExamplePath = Join-Path $repoRoot ".agents\projects.local.example.json"
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check([string] $Name, [bool] $Ok, [string] $Detail) {
    [void]$checks.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
}

if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    throw "Release project registry is missing: $registryPath"
}

$registry = Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$tracked = @(& git -C $repoRoot ls-files)
if ($LASTEXITCODE -ne 0) { throw "git ls-files failed." }
$trackedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($trackedPath in $tracked) { [void]$trackedSet.Add($trackedPath.Replace("\", "/")) }

$projectErrors = [System.Collections.Generic.List[string]]::new()
$ids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$rootExact = $repoRoot.TrimEnd('\')
$rootPrefix = "$rootExact\"
foreach ($project in @($registry.projects)) {
    $projectId = [string]$(if ($project.projectId) { $project.projectId } else { $project.id })
    $configuredPath = [string]$(if ($project.workspacePath) { $project.workspacePath } else { $project.path })
    if ([string]::IsNullOrWhiteSpace($projectId) -or [string]::IsNullOrWhiteSpace($configuredPath)) {
        $projectErrors.Add("Every release Project requires projectId and workspacePath.")
        continue
    }
    if (-not $ids.Add($projectId)) { $projectErrors.Add("Duplicate release projectId: $projectId") }
    if ([System.IO.Path]::IsPathRooted($configuredPath)) {
        $projectErrors.Add("Release Project '$projectId' uses an absolute path.")
        continue
    }
    try {
        $absolutePath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $configuredPath))
        $insideRoot = $absolutePath.TrimEnd('\').Equals($rootExact, [System.StringComparison]::OrdinalIgnoreCase) -or $absolutePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
        if (-not $insideRoot) {
            $projectErrors.Add("Release Project '$projectId' escapes the repository.")
            continue
        }
        if (-not (Test-Path -LiteralPath $absolutePath -PathType Container)) {
            $projectErrors.Add("Release Project '$projectId' does not exist: $configuredPath")
            continue
        }
        $gitPath = $configuredPath.Replace("\", "/").TrimStart("./")
        if ($configuredPath -ne ".") {
            $prefix = "$gitPath/"
            $trackedProjectFiles = @($tracked | Where-Object { $_.Replace("\", "/").StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) })
            if ($trackedProjectFiles.Count -eq 0) { $projectErrors.Add("Release Project '$projectId' has no tracked files: $configuredPath") }
            & git -C $repoRoot check-ignore -q -- $gitPath
            if ($LASTEXITCODE -eq 0) { $projectErrors.Add("Release Project '$projectId' is ignored by Git: $configuredPath") }
        }
    } catch {
        $projectErrors.Add("Release Project '$projectId' has an invalid path: $($_.Exception.Message)")
    }
}
Add-Check "Release Project materialization" ($projectErrors.Count -eq 0) $(if ($projectErrors.Count) { ($projectErrors | Select-Object -Unique) -join " " } else { "$(@($registry.projects).Count) release Projects exist and contain tracked files." })

$forbiddenTracked = @($tracked | Where-Object { $_ -eq ".agents/projects.local.json" -or $_ -eq "runtime-data" -or $_.StartsWith("runtime-data/") })
Add-Check "Runtime/local registry hygiene" ($forbiddenTracked.Count -eq 0) $(if ($forbiddenTracked.Count) { "Forbidden tracked paths: $($forbiddenTracked -join ', ')" } else { "Local registry and runtime-data are not tracked." })

$exampleGitPath = ".agents/projects.local.example.json"
& git -C $repoRoot check-ignore -q -- $exampleGitPath
$exampleIgnored = $LASTEXITCODE -eq 0
Add-Check "Local registry example" ((Test-Path -LiteralPath $localExamplePath -PathType Leaf) -and -not $exampleIgnored) $(if (-not (Test-Path -LiteralPath $localExamplePath -PathType Leaf)) { "Missing $exampleGitPath." } elseif ($exampleIgnored) { "$exampleGitPath is ignored." } else { "$exampleGitPath is release-visible." })

if (Test-Path -LiteralPath $localRegistryPath -PathType Leaf) {
    & git -C $repoRoot check-ignore -q -- ".agents/projects.local.json"
    $localIgnored = $LASTEXITCODE -eq 0
    Add-Check "Optional local registry" $localIgnored $(if ($localIgnored) { ".agents/projects.local.json is present and ignored." } else { ".agents/projects.local.json must be ignored." })
} else {
    Add-Check "Optional local registry" $true ".agents/projects.local.json is absent, which is supported."
}

$ok = @($checks | Where-Object { -not $_.ok }).Count -eq 0
$result = [pscustomobject]@{ ok = $ok; releaseProjects = @($registry.projects).Count; checks = $checks }
if ($Json) {
    $result | ConvertTo-Json -Depth 6
} else {
    Write-Host "Release Project validation" -ForegroundColor Cyan
    foreach ($check in $checks) {
        Write-Host ("{0} {1}: {2}" -f $(if ($check.ok) { "[OK]" } else { "[FAIL]" }), $check.name, $check.detail) -ForegroundColor $(if ($check.ok) { "Green" } else { "Red" })
    }
}
if (-not $ok) { exit 1 }

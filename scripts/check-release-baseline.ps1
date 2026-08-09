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
    "CHANGELOG.md",
    ".agents\release-status.json",
    ".agents\projects.json",
    ".agents\projects.local.example.json",
    ".agents\resource-profiles.json",
    ".agents\workflow-definitions.json",
    "runtime\supervisor-decision.mjs",
    "runtime\project-continuity.mjs",
    "runtime\project-continuity.test.mjs",
    "runtime\supervisor-collaboration.mjs",
    "runtime\supervisor-review-package.mjs",
    "runtime\project-intelligence.mjs",
    "runtime\project-context.mjs",
    "runtime\workflow-runtime.mjs",
    "runtime\provider-preflight.mjs",
    "runtime\failure-catalog.mjs",
    "scripts\provider-preflight.mjs",
    "scripts\invoke-claude-preflight.ps1",
    "scripts\onboarding-contract.test.mjs",
    "scripts\verify-release-projects.ps1",
    "scripts\run-node-tests.ps1",
    "scripts\test-discovery.mjs",
    "scripts\test-discovery.test.mjs",
    "workspace\supervisor-dashboard\index.html",
    "workspace\autonomous-beta-demo\index.html",
    "workspace\autonomous-beta-demo\app.js",
    "workspace\autonomous-beta-demo\styles.css",
    "workspace\autonomous-beta-demo\demo.test.mjs",
    "workspace\release-beta-todo-demo\index.html",
    "workspace\release-beta-todo-demo\app.js",
    "workspace\release-beta-todo-demo\styles.css",
    "workspace\release-beta-todo-demo\demo.test.mjs",
    "docs\v0.9-autonomous-validation.md",
    "docs\v1.0-beta-release-audit.md",
    "docs\ARCHITECTURE.md",
    "docs\project-memory.md",
    "docs\gpt-web-usage.md",
    "mcp-server\config.example.json"
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repoRoot $_)) })
Add-Check "Required product files" ($missing.Count -eq 0) $(if ($missing.Count) { "Missing: $($missing -join ', ')" } else { "All required v1.10-beta release files are present." })

$ignoredRequired = [System.Collections.Generic.List[string]]::new()
foreach ($relativePath in $required) {
    $gitPath = $relativePath.Replace("\", "/")
    & git -C $repoRoot check-ignore -q -- $gitPath
    if ($LASTEXITCODE -eq 0) { [void]$ignoredRequired.Add($gitPath) }
}
Add-Check "Release artifact visibility" ($ignoredRequired.Count -eq 0) $(if ($ignoredRequired.Count) { "Required files are ignored by Git: $($ignoredRequired -join ', ')" } else { "Required product files are visible to Git and can be included in a release." })

$package = Get-Content -LiteralPath (Join-Path $repoRoot "mcp-server\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Check "Release version" ([string]$package.version -eq "1.10.0-beta.1") "mcp-server package version is $($package.version)."

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
$invalidProjects = @($registry.projects | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.projectId) -or [string]::IsNullOrWhiteSpace([string]$_.workspacePath) -or [string]::IsNullOrWhiteSpace([string]$_.description) -or @($_.stack).Count -eq 0 -or @($_.aliases).Count -eq 0 -or @($_.constraints).Count -eq 0 })
Add-Check "Project context schema" ([int]$registry.schemaVersion -ge 3 -and $invalidProjects.Count -eq 0) $(if ($invalidProjects.Count) { "Projects missing projectId, workspacePath, description, stack, aliases, or constraints: $($invalidProjects.projectId -join ', ')" } else { "$(@($registry.projects).Count) registered projects satisfy schema v$($registry.schemaVersion)." })

$readme = Get-Content -LiteralPath (Join-Path $repoRoot "README.md") -Raw -Encoding UTF8
$flowMarkers = @("Five-minute quick start", "Clone the repository", ".\install.ps1", ".\scripts\doctor.ps1", "-ProviderPreflight", ".\start.ps1", "start-openai-tunnel.ps1", "cc_list_projects", "cc_list_workflow_definitions", "registered Project", "projectId", "Human Approval", "Harness Audit", "ChatGPT Supervisor Review", "Release Beta Todo Demo", "add CSV export to the task board", "/supervisor/", "Create recovery workflow", "v0.9 autonomous validation", "autonomous-beta-demo", "v1.0-beta release audit")
$missingFlow = @($flowMarkers | Where-Object { -not $readme.Contains($_) })
Add-Check "Operator quick start" ($missingFlow.Count -eq 0) $(if ($missingFlow.Count) { "README is missing: $($missingFlow -join ', ')" } else { "README documents clone/install/doctor/start/Dashboard usage." })

$installSource = Get-Content -LiteralPath (Join-Path $repoRoot "install.ps1") -Raw -Encoding UTF8
$firstRunContractPresent = $installSource.Contains('nodeMajor -lt 20') -and $installSource.Contains('Installing locked MCP dependencies') -and $readme.Contains('Those three commands are sufficient to start the local Dashboard')
Add-Check "First-run contract" $firstRunContractPresent "Install rejects unsupported Node.js versions and README separates local startup from the optional provider probe."

$preflightSource = Get-Content -LiteralPath (Join-Path $repoRoot "runtime\provider-preflight.mjs") -Raw -Encoding UTF8
$workflowSource = Get-Content -LiteralPath (Join-Path $repoRoot "runtime\workflow-runtime.mjs") -Raw -Encoding UTF8
$dashboardSource = Get-Content -LiteralPath (Join-Path $repoRoot "workspace\supervisor-dashboard\app.js") -Raw -Encoding UTF8
$preflightCliSource = Get-Content -LiteralPath (Join-Path $repoRoot "scripts\provider-preflight.mjs") -Raw -Encoding UTF8
$reliabilityMarkersPresent = $preflightSource.Contains('projectContentSent: false') -and $preflightSource.Contains('"--tools", ""') -and $preflightCliSource.Contains('ProviderPreflightService') -and $workflowSource.Contains('async retryWorkflow') -and $workflowSource.Contains('approvals: {}') -and $dashboardSource.Contains('/provider-preflight') -and $dashboardSource.Contains('/retry')
Add-Check "Reliability contracts" $reliabilityMarkersPresent "Provider isolation, fresh-approval recovery, and Dashboard controls are present."

$intelligenceSource = Get-Content -LiteralPath (Join-Path $repoRoot "runtime\project-intelligence.mjs") -Raw -Encoding UTF8
$architectureSource = Get-Content -LiteralPath (Join-Path $repoRoot "docs\ARCHITECTURE.md") -Raw -Encoding UTF8
$intelligenceMarkersPresent = $intelligenceSource.Contains('explicit_confirmation_required') -and $intelligenceSource.Contains('buildMemoryApplicationDocument') -and $intelligenceSource.Contains('beforeDigest') -and $dashboardSource.Contains('/project-intelligence') -and $dashboardSource.Contains('/memory-proposal/apply') -and $architectureSource.Contains('Project Intelligence Layer')
Add-Check "Project Intelligence contracts" $intelligenceMarkersPresent "Confirmed Supervisor Review persistence, controlled Memory apply, Dashboard projection, and architecture documentation are present."

$continuitySource = Get-Content -LiteralPath (Join-Path $repoRoot "runtime\project-continuity.mjs") -Raw -Encoding UTF8
$continuityMarkersPresent = $continuitySource.Contains('buildProjectBrief') -and $continuitySource.Contains('getArtifactCenter') -and $continuitySource.Contains('recommendedNextSteps') -and $dashboardSource.Contains('/continuity') -and $dashboardSource.Contains('/artifacts') -and $architectureSource.Contains('Project Continuity Layer')
Add-Check "Project Continuity contracts" $continuityMarkersPresent "Evidence-derived Project Briefs, read-only Artifact Center, Dashboard project view, and architecture documentation are present."

$releaseStatusRaw = Get-Content -LiteralPath (Join-Path $repoRoot ".agents\release-status.json") -Raw -Encoding UTF8
$releaseStatus = $releaseStatusRaw | ConvertFrom-Json
$gptWebUsage = Get-Content -LiteralPath (Join-Path $repoRoot "docs\gpt-web-usage.md") -Raw -Encoding UTF8
$dogfoodTimestampPersisted = $releaseStatusRaw -match '"lastGptWebDogfood"\s*:\s*"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"'
$healthMarkersPresent = $continuitySource.Contains('health') -and $dashboardSource.Contains('project-health-summary') -and [string]$releaseStatus.version -eq [string]$package.version -and [string]$releaseStatus.readiness -eq "ready_for_beta_release" -and $dogfoodTimestampPersisted -and $gptWebUsage.Contains('new ChatGPT Web conversation') -and $gptWebUsage.Contains('cc_get_supervisor_review_package')
Add-Check "v1.10 stabilization contracts" $healthMarkersPresent "Deterministic Project Health, release metadata, and the fresh-session GPT Web validation guide are present."

$demoSource = Get-Content -LiteralPath (Join-Path $repoRoot "workspace\autonomous-beta-demo\app.js") -Raw -Encoding UTF8
$demoCss = Get-Content -LiteralPath (Join-Path $repoRoot "workspace\autonomous-beta-demo\styles.css") -Raw -Encoding UTF8
$demoTest = Get-Content -LiteralPath (Join-Path $repoRoot "workspace\autonomous-beta-demo\demo.test.mjs") -Raw -Encoding UTF8
$demoContractPresent = $demoSource.Contains('keyword-search') -and $demoSource.Contains('state.keyword') -and $demoCss.Contains('@media (max-width: 600px)') -and $demoTest.Contains('emptyState: true')
Add-Check "Autonomous Demo contract" $demoContractPresent "Search, combined filtering, empty state, and mobile layout have a repeatable validation contract."

$releaseDemoTest = Get-Content -LiteralPath (Join-Path $repoRoot "workspace\release-beta-todo-demo\demo.test.mjs") -Raw -Encoding UTF8
$releaseDemoContractPresent = $releaseDemoTest.Contains('release todo contract')
Add-Check "Release Todo Demo contract" $releaseDemoContractPresent "The isolated Todo baseline has a dependency-free executable contract test; real-provider acceptance remains a separate conditional gate."

$tracked = @(& git -C $repoRoot ls-files)
$forbidden = @($tracked | Where-Object { $_ -eq ".agents/projects.local.json" -or $_ -match '(^|/)(config\.json|runtime-data|\.agents/runs|\.agent-runs|outbox|logs|tunnel-client-profiles)(/|$)' -or $_ -match '\.(bak|log)$|\.working-|^tunnel-client-logs-' })
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

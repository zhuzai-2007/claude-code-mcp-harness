[CmdletBinding()]
param(
    [switch] $Json,
    [switch] $ProviderPreflight,
    [ValidateRange(10, 300)][int] $ProviderPreflightTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repoRoot "mcp-server"
$packagePath = Join-Path $serverDir "package.json"
$nodeModulesPath = Join-Path $serverDir "node_modules"
$configPath = Join-Path $serverDir "config.json"

function New-Check {
    param(
        [string] $Name,
        [ValidateSet("ok", "warn", "error")][string] $Status,
        [string] $Detail,
        [string] $Advice = "",
        [bool] $Required = $true
    )
    [pscustomobject]@{ name = $Name; status = $Status; ok = ($Status -eq "ok"); required = $Required; detail = $Detail; advice = $Advice }
}

function Get-CommandCheck {
    param([string] $Name, [bool] $Required, [string] $Advice, [switch] $Version)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        return New-Check $Name $(if ($Required) { "error" } else { "warn" }) "Not found on PATH." $Advice $Required
    }
    $detail = $command.Source
    if ($Version) {
        try {
            $versionText = (& $command.Source --version 2>&1 | Out-String).Trim()
            if ($versionText) { $detail = ($versionText -split "`r?`n")[0] }
        } catch {}
    }
    return New-Check $Name "ok" $detail "" $Required
}

function Get-NvmNodeContext {
    $roots = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:NVM_HOME)) { $roots.Add([string]$env:NVM_HOME) }
    $nvmCommand = Get-Command "nvm" -ErrorAction SilentlyContinue
    if ($nvmCommand -and $nvmCommand.Source) { $roots.Add((Split-Path -Parent $nvmCommand.Source)) }

    foreach ($candidate in @($roots | Select-Object -Unique)) {
        try { $root = [System.IO.Path]::GetFullPath($candidate) } catch { continue }
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $versions = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Name -match '^v?(\d+\.\d+\.\d+)$' -and (Test-Path -LiteralPath (Join-Path $_.FullName "node.exe") -PathType Leaf)) {
                [pscustomobject]@{ Text = $Matches[1]; Version = [version]$Matches[1] }
            }
        } | Sort-Object Version -Descending)
        return [pscustomobject]@{ Root = $root; Versions = @($versions.Text) }
    }
    return $null
}

function Get-NodeCheck {
    $command = Get-Command "node" -ErrorAction SilentlyContinue
    if ($command) {
        $detail = $command.Source
        try {
            $versionText = (& $command.Source --version 2>&1 | Out-String).Trim()
            if ($versionText) { $detail = ($versionText -split "`r?`n")[0] }
        } catch {}
        return New-Check "node" "ok" $detail "" $true
    }

    $nvm = Get-NvmNodeContext
    if ($nvm) {
        $available = if ($nvm.Versions.Count) { $nvm.Versions -join ", " } else { "none detected" }
        $advice = if ($nvm.Versions.Count) {
            "Run: nvm use $($nvm.Versions[0]), then reopen PowerShell."
        } else {
            "Use the existing nvm installation to install and select Node.js 20 or newer, then reopen PowerShell."
        }
        return New-Check "node" "error" "Not found on PATH. nvm: $($nvm.Root). Available Node versions: $available." $advice $true
    }
    return New-Check "node" "error" "Not found on PATH." "Install Node.js 20 or newer, then reopen PowerShell." $true
}

function Get-JsonCheck {
    param([string] $Name, [string] $Path, [string] $Advice)
    if (-not (Test-Path -LiteralPath $Path)) { return New-Check $Name "error" "Missing: $Path" $Advice $true }
    try {
        $data = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        return [pscustomobject]@{ check = (New-Check $Name "ok" $Path); data = $data }
    } catch {
        return New-Check $Name "error" "Invalid JSON: $($_.Exception.Message)" $Advice $true
    }
}

$checks = [System.Collections.Generic.List[object]]::new()
$checks.Add((Get-NodeCheck))
$checks.Add((Get-CommandCheck "npm" $true "Install npm with Node.js, then reopen PowerShell." -Version))
$checks.Add((Get-CommandCheck "claude" $true "Install Claude Code CLI and confirm 'claude --version' works."))

if (Test-Path -LiteralPath $packagePath) {
    $checks.Add((New-Check "MCP package" "ok" $packagePath))
} else {
    $checks.Add((New-Check "MCP package" "error" "Missing package.json." "Clone the complete repository again."))
}
if (Test-Path -LiteralPath $nodeModulesPath) {
    $checks.Add((New-Check "MCP dependencies" "ok" $nodeModulesPath))
} else {
    $checks.Add((New-Check "MCP dependencies" "error" "node_modules is missing." "Run .\install.ps1 or npm ci --prefix .\mcp-server."))
}

$config = $null
$configResult = Get-JsonCheck "Local config" $configPath "Run .\scripts\init-config.ps1."
if ($configResult.PSObject.Properties["check"]) {
    $checks.Add($configResult.check)
    $config = $configResult.data
} else { $checks.Add($configResult) }

$projectRoot = $repoRoot
if ($config) {
    try {
        $projectRoot = [System.IO.Path]::GetFullPath([string]$config.projectRoot)
        if (Test-Path -LiteralPath $projectRoot) {
            $checks.Add((New-Check "Project workspace" "ok" $projectRoot))
        } else {
            $checks.Add((New-Check "Project workspace" "error" "Configured path does not exist: $projectRoot" "Update projectRoot in mcp-server\config.json."))
        }
    } catch {
        $checks.Add((New-Check "Project workspace" "error" $_.Exception.Message "Set projectRoot to an existing absolute path."))
    }
}

foreach ($entry in @(
    @{ Name = "Execution policy"; Path = (Join-Path $projectRoot ".agents\policy.json"); Advice = "Run .\install.ps1 -TargetProject <path> to install the Harness." },
    @{ Name = "Resource profiles"; Path = (Join-Path $projectRoot ".agents\resource-profiles.json"); Advice = "Restore .agents\resource-profiles.json from the repository." },
    @{ Name = "Workflow definitions"; Path = (Join-Path $projectRoot ".agents\workflow-definitions.json"); Advice = "Restore .agents\workflow-definitions.json from the repository." }
    @{ Name = "Release project registry"; Path = (Join-Path $projectRoot ".agents\projects.json"); Advice = "Restore the checked-in .agents\projects.json release registry." }
)) {
    $result = Get-JsonCheck $entry.Name $entry.Path $entry.Advice
    $checks.Add($(if ($result.PSObject.Properties["check"]) { $result.check } else { $result }))
}

$projectRegistryPath = Join-Path $projectRoot ".agents\projects.json"
$localProjectRegistryPath = Join-Path $projectRoot ".agents\projects.local.json"
if (Test-Path -LiteralPath $localProjectRegistryPath) {
    $localResult = Get-JsonCheck "Local project registry" $localProjectRegistryPath "Repair .agents\projects.local.json or copy .agents\projects.local.example.json."
    $checks.Add($(if ($localResult.PSObject.Properties["check"]) { $localResult.check } else { $localResult }))
} else {
    $checks.Add((New-Check "Local project registry" "ok" "Not configured (optional)." "Copy .agents\projects.local.example.json only when local Projects are needed." $false))
}

if (Test-Path -LiteralPath $projectRegistryPath) {
    try {
        $releaseRegistry = Get-Content -LiteralPath $projectRegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $localRegistry = if (Test-Path -LiteralPath $localProjectRegistryPath) {
            Get-Content -LiteralPath $localProjectRegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } else {
            [pscustomobject]@{ projects = @() }
        }
        $projectErrors = [System.Collections.Generic.List[string]]::new()
        $projectIds = @{}
        $registries = @(
            [pscustomobject]@{ Name = "release"; Projects = @($releaseRegistry.projects) },
            [pscustomobject]@{ Name = "local"; Projects = @($localRegistry.projects) }
        )
        foreach ($registry in $registries) {
          foreach ($project in @($registry.Projects)) {
            $registeredId = [string]$(if ($project.projectId) { $project.projectId } else { $project.id })
            $configuredPath = [string]$(if ($project.workspacePath) { $project.workspacePath } else { $project.path })
            $configuredStack = @($(if ($project.stack) { $project.stack } else { $project.techStack }))
            $configuredConstraints = @($(if ($project.constraints) { $project.constraints } else { $project.defaultConstraints }))
            if ([string]::IsNullOrWhiteSpace($registeredId) -or [string]::IsNullOrWhiteSpace($configuredPath) -or [string]::IsNullOrWhiteSpace([string]$project.description)) { $projectErrors.Add("Each project requires projectId, workspacePath, and description.") }
            if (-not [string]::IsNullOrWhiteSpace($registeredId)) {
                if ($projectIds.ContainsKey($registeredId)) { $projectErrors.Add("Project id '$registeredId' is duplicated across $($projectIds[$registeredId]) and $($registry.Name) registries.") }
                else { $projectIds[$registeredId] = $registry.Name }
            }
            if ($configuredStack.Count -eq 0) { $projectErrors.Add("Project '$registeredId' has no stack.") }
            if (@($project.aliases).Count -eq 0) { $projectErrors.Add("Project '$registeredId' has no aliases.") }
            if ($configuredConstraints.Count -eq 0) { $projectErrors.Add("Project '$registeredId' has no constraints.") }
            try {
                if ($registry.Name -eq "local" -and [System.IO.Path]::IsPathRooted($configuredPath)) { throw "Local Project paths must be relative." }
                $registeredPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $configuredPath))
                $rootExact = $projectRoot.TrimEnd('\')
                $rootPrefix = "$rootExact\"
                $insideRoot = $registeredPath.TrimEnd('\').Equals($rootExact, [System.StringComparison]::OrdinalIgnoreCase) -or $registeredPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
                if (-not $insideRoot -or -not (Test-Path -LiteralPath $registeredPath -PathType Container)) { $projectErrors.Add("Project '$registeredId' workspacePath is missing or outside projectRoot.") }
                if ($registry.Name -eq "local") {
                    $workspaceExact = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "workspace")).TrimEnd('\')
                    $workspacePrefix = "$workspaceExact\"
                    if (-not $registeredPath.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { $projectErrors.Add("Local project '$registeredId' must be inside the workspace root.") }
                }
            } catch { $projectErrors.Add("Project '$registeredId' workspacePath is invalid: $($_.Exception.Message)") }
          }
        }
        $projectCount = @($releaseRegistry.projects).Count + @($localRegistry.projects).Count
        $checks.Add((New-Check "Project context contract" $(if ($projectErrors.Count) { "error" } else { "ok" }) $(if ($projectErrors.Count) { ($projectErrors | Select-Object -Unique) -join " " } else { "$projectCount release/local projects include unique projectId, safe workspacePath, stack, aliases, and constraints." }) "Update .agents\projects.json or the ignored .agents\projects.local.json before startup."))
    } catch {
        $checks.Add((New-Check "Project context contract" "error" $_.Exception.Message "Repair .agents\projects.json or .agents\projects.local.json."))
    }
}

$bridgeUrl = $null
$health = $null
if ($config) {
    $hostName = if ($config.host) { [string]$config.host } else { "127.0.0.1" }
    $port = if ($config.port) { [int]$config.port } else { 8787 }
    $bridgeUrl = "http://${hostName}:${port}"
    try {
        $health = Invoke-RestMethod -Uri "$bridgeUrl/health" -TimeoutSec 2
        if ($health.ok) { $checks.Add((New-Check "MCP Bridge" "ok" "$bridgeUrl/health" "" $false)) }
        else { $checks.Add((New-Check "MCP Bridge" "warn" "Health endpoint did not report ok." "Start it with .\start.ps1." $false)) }
    } catch {
        $checks.Add((New-Check "MCP Bridge" "warn" "Not running at $bridgeUrl." "After required checks pass, run .\start.ps1." $false))
    }
} else {
    $checks.Add((New-Check "MCP Bridge" "warn" "Cannot determine endpoint until config exists." "Run .\scripts\init-config.ps1." $false))
}

$tunnel = Get-Command "tunnel-client" -ErrorAction SilentlyContinue
if (-not $tunnel) {
    $checks.Add((New-Check "OpenAI Tunnel" "warn" "tunnel-client is not installed." "Install it only when connecting ChatGPT Web; local Dashboard use does not require it." $false))
} elseif ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    $checks.Add((New-Check "OpenAI Tunnel" "warn" "CLI found, but CONTROL_PLANE_API_KEY is not set." "Set the key only in the terminal that starts the tunnel; never commit it." $false))
} else {
    $checks.Add((New-Check "OpenAI Tunnel" "ok" "CLI and runtime key are available. Secret value was not read or printed." "" $false))
}

$proxyConfigured = -not [string]::IsNullOrWhiteSpace($env:HTTPS_PROXY) -or -not [string]::IsNullOrWhiteSpace($env:HTTP_PROXY)
$checks.Add((New-Check "Network proxy" $(if ($proxyConfigured) { "ok" } else { "warn" }) $(if ($proxyConfigured) { "Proxy environment is configured; values are hidden." } else { "No HTTP_PROXY/HTTPS_PROXY set." }) "Set proxy environment variables only when command-line network access requires them." $false))
$latestPreflight = if ($health -and $health.providerPreflight.latest) {
    $health.providerPreflight.latest
} else {
    $latestPreflightPath = Join-Path $repoRoot "runtime-data\provider-preflight\latest.json"
    if (Test-Path -LiteralPath $latestPreflightPath) {
        try { Get-Content -LiteralPath $latestPreflightPath -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { $null }
    } else { $null }
}
if ($ProviderPreflight) {
    try {
        $preflightScript = Join-Path $repoRoot "scripts\provider-preflight.mjs"
        $preflightText = (& node $preflightScript --json --timeout $ProviderPreflightTimeoutSeconds 2>&1 | Out-String).Trim()
        $preflightExit = $LASTEXITCODE
        $preflight = $preflightText | ConvertFrom-Json
        $detail = "$($preflight.classification): $($preflight.message)"
        $advice = if (@($preflight.recoverySteps).Count) { @($preflight.recoverySteps) -join " " } else { "Provider is ready for a reviewed Workflow." }
        $checks.Add((New-Check "Provider preflight" $(if ($preflight.status -eq "ok" -and $preflightExit -eq 0) { "ok" } else { "warn" }) $detail $advice $false))
    } catch {
        $checks.Add((New-Check "Provider preflight" "warn" "Preflight could not produce a structured result." "Run node .\scripts\provider-preflight.mjs and inspect the local environment. $($_.Exception.Message)" $false))
    }
} elseif ($latestPreflight) {
    $checks.Add((New-Check "Provider preflight" $(if ($latestPreflight.status -eq "ok") { "ok" } else { "warn" }) "Latest: $($latestPreflight.classification) at $($latestPreflight.checkedAt)." "Use .\scripts\doctor.ps1 -ProviderPreflight to run a fresh fixed probe." $false))
} else {
    $checks.Add((New-Check "Provider preflight" "warn" "Not run. Default doctor performs no external model call." "Run .\scripts\doctor.ps1 -ProviderPreflight before real dogfood. The probe sends no project content and exposes no tools." $false))
}

$hasErrors = @($checks | Where-Object { $_.status -eq "error" }).Count -gt 0
$hasWarnings = @($checks | Where-Object { $_.status -eq "warn" }).Count -gt 0
$result = [pscustomobject]@{
    ok = -not $hasErrors
    status = if ($hasErrors) { "error" } elseif ($hasWarnings) { "ready_with_warnings" } else { "ready" }
    repoRoot = $repoRoot
    dashboardUrl = if ($bridgeUrl) { "$bridgeUrl/supervisor/" } else { $null }
    checks = $checks
}

if ($Json) {
    $result | ConvertTo-Json -Depth 8
} else {
    Write-Host ""
    Write-Host "Supervisor v1.10 Beta doctor" -ForegroundColor Cyan
    Write-Host "Repository: $repoRoot"
    Write-Host ""
    foreach ($check in $checks) {
        $prefix = if ($check.status -eq "ok") { "[OK]  " } elseif ($check.status -eq "warn") { "[WARN]" } else { "[FAIL]" }
        $color = if ($check.status -eq "ok") { "Green" } elseif ($check.status -eq "warn") { "Yellow" } else { "Red" }
        Write-Host ("{0} {1}: {2}" -f $prefix, $check.name, $check.detail) -ForegroundColor $color
        if ($check.advice) { Write-Host ("       Next: {0}" -f $check.advice) -ForegroundColor DarkGray }
    }
    Write-Host ""
    if ($hasErrors) {
        Write-Host "Not ready. Resolve [FAIL] items, then run doctor again." -ForegroundColor Red
    } elseif ($hasWarnings) {
        Write-Host "Ready for local use. [WARN] items are optional or expected before startup." -ForegroundColor Yellow
    } else {
        Write-Host "Ready. Start Supervisor with .\start.ps1" -ForegroundColor Green
    }
}

if ($hasErrors) { exit 1 }

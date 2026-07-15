[CmdletBinding()]
param(
    [switch] $Json
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
$checks.Add((Get-CommandCheck "node" $true "Install Node.js 20 or newer, then reopen PowerShell." -Version))
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
    @{ Name = "Project registry"; Path = (Join-Path $projectRoot ".agents\projects.json"); Advice = "Restore .agents\projects.json and register local project paths before using Supervisor." }
)) {
    $result = Get-JsonCheck $entry.Name $entry.Path $entry.Advice
    $checks.Add($(if ($result.PSObject.Properties["check"]) { $result.check } else { $result }))
}

$projectRegistryPath = Join-Path $projectRoot ".agents\projects.json"
if (Test-Path -LiteralPath $projectRegistryPath) {
    try {
        $registry = Get-Content -LiteralPath $projectRegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $projectErrors = [System.Collections.Generic.List[string]]::new()
        foreach ($project in @($registry.projects)) {
            if ([string]::IsNullOrWhiteSpace([string]$project.id) -or [string]::IsNullOrWhiteSpace([string]$project.path) -or [string]::IsNullOrWhiteSpace([string]$project.description)) { $projectErrors.Add("Each project requires id, path, and description.") }
            if (@($project.techStack).Count -eq 0) { $projectErrors.Add("Project '$($project.id)' has no techStack.") }
            if (@($project.aliases).Count -eq 0) { $projectErrors.Add("Project '$($project.id)' has no aliases.") }
            if (@($project.defaultConstraints).Count -eq 0) { $projectErrors.Add("Project '$($project.id)' has no defaultConstraints.") }
            try {
                $registeredPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot ([string]$project.path)))
                $rootExact = $projectRoot.TrimEnd('\')
                $rootPrefix = "$rootExact\"
                $insideRoot = $registeredPath.TrimEnd('\').Equals($rootExact, [System.StringComparison]::OrdinalIgnoreCase) -or $registeredPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
                if (-not $insideRoot -or -not (Test-Path -LiteralPath $registeredPath -PathType Container)) { $projectErrors.Add("Project '$($project.id)' path is missing or outside projectRoot.") }
            } catch { $projectErrors.Add("Project '$($project.id)' path is invalid.") }
        }
        $checks.Add((New-Check "Project context contract" $(if ($projectErrors.Count) { "error" } else { "ok" }) $(if ($projectErrors.Count) { ($projectErrors | Select-Object -Unique) -join " " } else { "$(@($registry.projects).Count) registered projects include stack, aliases, and default constraints." }) "Update .agents\projects.json before startup."))
    } catch {
        $checks.Add((New-Check "Project context contract" "error" $_.Exception.Message "Repair .agents\projects.json."))
    }
}

$bridgeUrl = $null
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
$checks.Add((New-Check "External Worker connectivity" "warn" "Doctor does not send project content or make a paid model call." "Run a reviewed read-only dogfood after confirming provider and proxy access." $false))

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
    Write-Host "Supervisor v0.7 RC doctor" -ForegroundColor Cyan
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

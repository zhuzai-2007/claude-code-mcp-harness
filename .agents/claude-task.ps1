[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("plan", "run", "review")]
    [string] $Mode,
    [Parameter(Position = 1)]
    [string] $Task,
    [string] $TaskFile,
    [string] $InputJson,
    [decimal] $BudgetUsd = -1,
    [decimal] $MaxBudgetUsd = 0.10,
    [string] $Model,
    [string[]] $AllowDir = @(),
    [string[]] $ContextFiles = @(),
    [int] $MaxFilesRead = 20,
    [int] $MaxCommands = 8,
    [int] $WorkerTimeoutSeconds = 120,
    [string] $ApprovedBy,
    [string] $ApprovalReason,
    [switch] $AllowNetwork,
    [switch] $AllowDependencyInstall,
    [switch] $AllowGitWrite,
    [switch] $AllowRecursiveDelete,
    [switch] $Bare,
    [switch] $NoBare,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ExitCodes = @{ success = 0; worker_failed = 1; policy_blocked = 2; invalid_input = 3; environment_failed = 4 }
$maxBudgetProvided = $PSBoundParameters.ContainsKey('MaxBudgetUsd')
$budgetProvided = $PSBoundParameters.ContainsKey('BudgetUsd')

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string] $Path)
    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Test-IsPathInside {
    param([Parameter(Mandatory = $true)][string] $Child, [Parameter(Mandatory = $true)][string] $Parent)
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    return $childFull.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $childFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
        $childFull.StartsWith($parentFull + [System.IO.Path]::AltDirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-Array {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return @($Value) }
    return @($Value)
}

function Get-PropValue {
    param($Object, [Parameter(Mandatory = $true)][string] $Name)
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function ConvertFrom-WorkerJsonText {
    param([AllowNull()][string] $Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $trimmed = $Text.Trim()
    if ($trimmed -match '(?s)^```(?:json)?\s*(.*?)\s*```$') {
        $trimmed = $Matches[1].Trim()
    }
    try { return ($trimmed | ConvertFrom-Json) } catch { return $null }
}

function ConvertTo-ShortText {
    param($Value)
    if ($null -eq $Value) { return $null }
    $text = if ($Value -is [string]) { $Value } else { ($Value | ConvertTo-Json -Depth 4 -Compress) }
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    if ($text.Length -gt 300) { return $text.Substring(0, 300) }
    return $text
}

function Protect-Text {
    param([AllowNull()][string] $Text)
    if ($null -eq $Text) { return $null }
    $redacted = $Text
    foreach ($pattern in @('(?i)(api[_-]?key\s*[:=]\s*)[^\s,''"]+', '(?i)(token\s*[:=]\s*)[^\s,''"]+', '(?i)(password\s*[:=]\s*)[^\s,''"]+', '(?i)(secret\s*[:=]\s*)[^\s,''"]+', '(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,''"]+')) {
        $redacted = [regex]::Replace($redacted, $pattern, '$1<redacted>')
    }
    return $redacted
}

function Save-Json {
    param([Parameter(Mandatory = $true)] $Value, [Parameter(Mandatory = $true)][string] $Path, [int] $Depth = 10)
    $Value | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $Path -Encoding UTF8
}

function New-NormalizedResult {
    param(
        [string] $Status,
        [string] $Mode,
        [string] $Summary,
        [object[]] $FilesRead = @(),
        [object[]] $ChangesMade = @(),
        [object[]] $CommandsRun = @(),
        [object[]] $TestsOrChecks = @(),
        [object[]] $Risks = @(),
        [object[]] $BlockedOn = @(),
        $Cost = $null,
        [hashtable] $Artifacts = @{},
        $ErrorObject = $null
    )
    return [ordered]@{
        status = $Status
        mode = $Mode
        summary = $Summary
        files_read = @($FilesRead)
        changes_made = @($ChangesMade)
        commands_run = @($CommandsRun)
        tests_or_checks = @($TestsOrChecks)
        risks = @($Risks)
        blocked_on = @($BlockedOn)
        cost = $Cost
        artifacts = $Artifacts
        error = $ErrorObject
    }
}

function Complete-Run {
    param(
        [string] $RunDir,
        [string] $RunId,
        [string] $Mode,
        [string] $ProjectRoot,
        [hashtable] $ExitCodes,
        [string] $Status,
        $Normalized,
        [string] $RawOutputPath,
        [string] $ErrorPath,
        [int] $ClaudeExitCode = -1
    )
    $normalizedPath = Join-Path $RunDir 'worker-result.normalized.json'
    Save-Json -Value $Normalized -Path $normalizedPath -Depth 12
    Save-Json -Value ([ordered]@{
        runId = $RunId
        mode = $Mode
        projectRoot = $ProjectRoot
        completedAt = (Get-Date).ToString('o')
        status = $Status
        exitCode = $ExitCodes[$Status]
        claudeExitCode = $ClaudeExitCode
        normalized = $normalizedPath
        output = $RawOutputPath
        error = $ErrorPath
    }) -Path (Join-Path $RunDir 'result.json') -Depth 8
    Write-Host "Worker run complete."
    Write-Host "Mode: $Mode"
    Write-Host "Run dir: $RunDir"
    Write-Host "Status: $Status"
    exit $ExitCodes[$Status]
}

function New-RunDirectory {
    param([string] $AgentsRoot, [string] $ProjectRoot)
    $runId = (Get-Date).ToString("yyyyMMdd-HHmmss-fff")
    $preferredRunRoot = Join-Path $AgentsRoot 'runs'
    $fallbackRunRoot = Join-Path $ProjectRoot '.agent-runs'
    $runRoot = $preferredRunRoot
    $runDir = Join-Path $runRoot $runId
    try {
        New-Item -ItemType Directory -Force -Path $runDir | Out-Null
    } catch {
        $runRoot = $fallbackRunRoot
        $runDir = Join-Path $runRoot $runId
        New-Item -ItemType Directory -Force -Path $runDir | Out-Null
    }
    return [ordered]@{ runId = $runId; runRoot = $runRoot; runDir = $runDir; preferredRunRoot = $preferredRunRoot; fallbackRunRoot = $fallbackRunRoot }
}

function Test-ReadonlyTools {
    param($ModePolicy)
    foreach ($tool in ConvertTo-Array $ModePolicy.allowedTools) {
        if (@('Edit', 'MultiEdit', 'Write') -contains [string]$tool) { return $false }
    }
    return $true
}

function Get-PolicyViolations {
    param([string] $TaskText, [string] $Mode, [bool] $HasApproval, [bool] $AllowNetwork, [bool] $AllowDependencyInstall, [bool] $AllowGitWrite, [bool] $AllowRecursiveDelete, [object[]] $ExternalAllowDirs)
    $violations = New-Object System.Collections.Generic.List[string]
    if ($Mode -eq 'run' -and -not $HasApproval) { $violations.Add('run mode requires -ApprovedBy and -ApprovalReason') }
    if ($ExternalAllowDirs.Count -gt 0 -and -not $HasApproval) { $violations.Add('external AllowDir requires approval') }
    foreach ($check in @(
        @{ name = 'git write'; pattern = '(?i)\bgit\s+(commit|push|tag|reset|checkout|merge|rebase)\b'; allowed = $AllowGitWrite },
        @{ name = 'dependency install'; pattern = '(?i)\b(npm|pnpm|yarn|pip|poetry|cargo|go|dotnet)\s+(install|add|get|restore)\b'; allowed = $AllowDependencyInstall },
        @{ name = 'network access'; pattern = '(?i)\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b|https?://'; allowed = $AllowNetwork },
        @{ name = 'recursive delete'; pattern = '(?i)(Remove-Item\b.*\b-Recurse\b|\brm\s+(-rf|-fr)\b|\brmdir\s+/s\b)'; allowed = $AllowRecursiveDelete }
    )) {
        if ($TaskText -match $check.pattern -and -not $check.allowed) { $violations.Add("blocked $($check.name); explicit allow switch and approval are required") }
        if ($TaskText -match $check.pattern -and $check.allowed -and -not $HasApproval) { $violations.Add("$($check.name) allow switch also requires approval") }
    }
    return @($violations)
}

if (-not $PSScriptRoot) { throw 'This script must be run from a file path, not an inline PowerShell session.' }
$agentsRoot = Resolve-FullPath $PSScriptRoot
$projectRoot = Resolve-FullPath (Join-Path $agentsRoot '..')
$runInfo = New-RunDirectory -AgentsRoot $agentsRoot -ProjectRoot $projectRoot
$runId = $runInfo.runId
$runDir = $runInfo.runDir
$stdoutPath = Join-Path $runDir 'claude-output.json'
$stderrPath = Join-Path $runDir 'claude-error.txt'
Save-Json -Value ([ordered]@{ runId = $runId; mode = $Mode; projectRoot = $projectRoot; startedAt = (Get-Date).ToString('o'); status = 'in_progress' }) -Path (Join-Path $runDir 'in_progress.json') -Depth 5

try {
    $policyPath = Join-Path $agentsRoot 'policy.json'
    if (-not (Test-Path -LiteralPath $policyPath)) { throw "Missing policy file: $policyPath" }
    $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
    if (-not $policy.modes.$Mode) { throw "Mode '$Mode' is not configured in policy.json." }
    $modePolicy = $policy.modes.$Mode
    $localConfig = $null
    $localConfigPath = Join-Path $agentsRoot 'local.config.json'
    if (Test-Path -LiteralPath $localConfigPath) {
        $localConfig = Get-Content -LiteralPath $localConfigPath -Raw | ConvertFrom-Json
    }

    if ($InputJson) {
        $inputPath = Resolve-FullPath $InputJson
        if (-not (Test-IsPathInside -Child $inputPath -Parent $projectRoot)) { throw "InputJson must be inside the project root. InputJson=$inputPath ProjectRoot=$projectRoot" }
        $input = Get-Content -LiteralPath $inputPath -Raw | ConvertFrom-Json
        $props = $input.PSObject.Properties
        if ($props['task']) { $Task = [string]$props['task'].Value }
        if ($props['taskFile']) { $TaskFile = [string]$props['taskFile'].Value }
        if ($props['budgetUsd'] -and -not $budgetProvided) { $BudgetUsd = [decimal]$props['budgetUsd'].Value; $budgetProvided = $true }
        if ($props['maxBudgetUsd'] -and -not $maxBudgetProvided) { $MaxBudgetUsd = [decimal]$props['maxBudgetUsd'].Value; $maxBudgetProvided = $true }
        if ($props['model'] -and -not $Model) { $Model = [string]$props['model'].Value }
        if ($props['contextFiles']) { $ContextFiles = @($props['contextFiles'].Value) }
        if ($props['maxFilesRead']) { $MaxFilesRead = [int]$props['maxFilesRead'].Value }
        if ($props['maxCommands']) { $MaxCommands = [int]$props['maxCommands'].Value }
        if ($props['workerTimeoutSeconds']) { $WorkerTimeoutSeconds = [int]$props['workerTimeoutSeconds'].Value }
        if ($props['approvedBy'] -and -not $ApprovedBy) { $ApprovedBy = [string]$props['approvedBy'].Value }
        if ($props['approvalReason'] -and -not $ApprovalReason) { $ApprovalReason = [string]$props['approvalReason'].Value }
    }

    if ($WorkerTimeoutSeconds -lt 1) { throw 'WorkerTimeoutSeconds must be 1 or higher.' }
    if ([string]::IsNullOrWhiteSpace($Task) -and [string]::IsNullOrWhiteSpace($TaskFile)) { throw 'Provide either -Task, -TaskFile, or -InputJson with task/taskFile.' }
    if ($TaskFile) {
        $taskFilePath = Resolve-FullPath $TaskFile
        if (-not (Test-IsPathInside -Child $taskFilePath -Parent $projectRoot)) { throw "TaskFile must be inside the project root. TaskFile=$taskFilePath ProjectRoot=$projectRoot" }
        $Task = Get-Content -LiteralPath $taskFilePath -Raw
    }

    if (($Mode -eq 'plan' -or $Mode -eq 'review') -and -not (Test-ReadonlyTools -ModePolicy $modePolicy)) { throw "Policy error: mode '$Mode' includes write-capable tools." }
    if ((-not $maxBudgetProvided) -and $budgetProvided -and $BudgetUsd -ge 0) { $MaxBudgetUsd = $BudgetUsd; $maxBudgetProvided = $true }
    if ((-not $maxBudgetProvided) -and $localConfig) {
        $localProps = $localConfig.PSObject.Properties
        if ($localProps['maxBudgetUsd']) { $MaxBudgetUsd = [decimal]$localProps['maxBudgetUsd'].Value }
    }
    if ((-not $maxBudgetProvided) -and (-not $localConfig) -and $policy.defaultBudgetUsd) { $MaxBudgetUsd = [decimal]$policy.defaultBudgetUsd }
    if ($MaxBudgetUsd -le 0) { throw "MaxBudgetUsd must be a positive number." }
    if ($MaxBudgetUsd -gt 5.00) { throw "MaxBudgetUsd must be less than or equal to 5.00. Refusing requested value: $MaxBudgetUsd" }
    $BudgetUsd = $MaxBudgetUsd
    $effectiveBare = -not [bool]$NoBare
    if ($Bare) { $effectiveBare = $true }

    $resolvedAllowDirs = @()
    foreach ($dir in $AllowDir) {
        $resolved = Resolve-FullPath $dir
        if (-not (Test-IsPathInside -Child $resolved -Parent $projectRoot)) { $resolvedAllowDirs += $resolved }
    }
    $resolvedContextFiles = @()
    foreach ($file in $ContextFiles) {
        $resolved = Resolve-FullPath $file
        if (-not (Test-IsPathInside -Child $resolved -Parent $projectRoot)) { throw "ContextFiles must be inside the project root. File=$resolved ProjectRoot=$projectRoot" }
        $resolvedContextFiles += $resolved
    }

    $hasApproval = -not [string]::IsNullOrWhiteSpace($ApprovedBy) -and -not [string]::IsNullOrWhiteSpace($ApprovalReason)
    $violations = @(Get-PolicyViolations -TaskText $Task -Mode $Mode -HasApproval $hasApproval -AllowNetwork ([bool]$AllowNetwork) -AllowDependencyInstall ([bool]$AllowDependencyInstall) -AllowGitWrite ([bool]$AllowGitWrite) -AllowRecursiveDelete ([bool]$AllowRecursiveDelete) -ExternalAllowDirs $resolvedAllowDirs)

    $systemPrompt = @"
You are Claude Code running as a bounded worker for Codex.

Hard boundaries:
- Project root is: $projectRoot
- Treat the project root as the only default workspace.
- Do not read or modify files outside the project root unless an allowed external directory is explicitly listed below.
- Do not read secrets, global Claude/Codex settings, shell profiles, credential stores, or full environment variables.
- Do not use dangerous permission bypass modes.
- Do not run recursive delete commands.
- Do not commit, push, install dependencies, or use network access unless this run metadata explicitly allows it.

Mode:
- Current mode is '$Mode'.
- In plan and review modes, do not modify files.
- In run mode, make only the requested project-local ordinary changes and stop if risky action is needed.

Efficiency limits:
- Keep output concise JSON. Do not quote full file contents.
- Prefer the provided context files before broad searches.
- Soft limits: read at most $MaxFilesRead files and run at most $MaxCommands shell commands.

Required response shape:
- Return JSON with: summary, files_read, changes_made, commands_run, tests_or_checks, risks, blocked_on.
- If you need Codex approval, put the exact request in blocked_on and stop.
"@
    if ($resolvedAllowDirs.Count -gt 0) {
        $systemPrompt += "`nExplicit one-time external directories approved for this run:`n"
        foreach ($dir in $resolvedAllowDirs) { $systemPrompt += "- $dir`n" }
    }
    $prompt = "Task:`n$(Protect-Text $Task)`n"
    if ($resolvedContextFiles.Count -gt 0) {
        $prompt += "`nContext files:`n"
        foreach ($file in $resolvedContextFiles) { $prompt += "- $file`n" }
    }

    $meta = [ordered]@{
        runId = $runId; mode = $Mode; projectRoot = $projectRoot; agentsRoot = $agentsRoot; runRoot = $runInfo.runRoot
        preferredRunRoot = $runInfo.preferredRunRoot; fallbackRunRoot = $runInfo.fallbackRunRoot; startedAt = (Get-Date).ToString('o')
        budgetUsd = $BudgetUsd; permissionMode = $modePolicy.permissionMode; outputFormat = $modePolicy.outputFormat; allowedTools = $modePolicy.allowedTools
        model = if ($Model) { $Model } else { '<claude-default>' }; bare = [bool]$effectiveBare; dryRun = [bool]$DryRun
        workerTimeoutSeconds = $WorkerTimeoutSeconds
        approvedBy = Protect-Text $ApprovedBy; approvalReason = Protect-Text $ApprovalReason
        externalAllowDirs = $resolvedAllowDirs; contextFiles = $resolvedContextFiles; maxFilesRead = $MaxFilesRead; maxCommands = $MaxCommands
        allowNetwork = [bool]$AllowNetwork; allowDependencyInstall = [bool]$AllowDependencyInstall; allowGitWrite = [bool]$AllowGitWrite; allowRecursiveDelete = [bool]$AllowRecursiveDelete
    }
    Save-Json -Value $meta -Path (Join-Path $runDir 'meta.json') -Depth 10
    $prompt | Set-Content -LiteralPath (Join-Path $runDir 'prompt.txt') -Encoding UTF8
    (Protect-Text $systemPrompt) | Set-Content -LiteralPath (Join-Path $runDir 'system-prompt.txt') -Encoding UTF8

    if ($violations.Count -gt 0) {
        $normalized = New-NormalizedResult -Status 'policy_blocked' -Mode $Mode -Summary 'Worker run blocked by local policy before invoking Claude.' -BlockedOn $violations -Artifacts @{ run_dir = $runDir }
        Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'policy_blocked' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
    }

    $claudeArgs = @()
    if ($effectiveBare) { $claudeArgs += '--bare' }
    $claudeArgs += @('-p', '--permission-mode', [string]$modePolicy.permissionMode, '--output-format', [string]$modePolicy.outputFormat, '--max-budget-usd', ([string]$BudgetUsd), '--system-prompt', $systemPrompt)
    if ($modePolicy.allowedTools -and $modePolicy.allowedTools.Count -gt 0) { $claudeArgs += '--allowedTools'; $claudeArgs += ($modePolicy.allowedTools -join ',') }
    if ($Model) { $claudeArgs += '--model'; $claudeArgs += $Model }
    foreach ($dir in $resolvedAllowDirs) { $claudeArgs += '--add-dir'; $claudeArgs += $dir }
    $commandLinePreview = 'claude ' + (($claudeArgs | ForEach-Object { if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ') + ' < prompt.txt'
    $commandLinePreview | Set-Content -LiteralPath (Join-Path $runDir 'command.txt') -Encoding UTF8

    if ($DryRun) {
        $normalized = New-NormalizedResult -Status 'success' -Mode $Mode -Summary 'Dry run only. Claude was not invoked.' -Artifacts @{ run_dir = $runDir; command = (Join-Path $runDir 'command.txt') }
        Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'success' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath -ClaudeExitCode 0
    }

    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claude) {
        $normalized = New-NormalizedResult -Status 'environment_failed' -Mode $Mode -Summary "Claude Code command 'claude' was not found on PATH." -ErrorObject @{ code = 'claude_not_found'; message = "Claude Code command 'claude' was not found on PATH." } -Artifacts @{ run_dir = $runDir }
        Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'environment_failed' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
    }

    $job = Start-Job -ScriptBlock {
        param($ProjectRoot, $PromptText, $ArgsForClaude, $ErrPath)
        Set-Location -LiteralPath $ProjectRoot
        try {
            $out = $PromptText | & claude @ArgsForClaude 2> $ErrPath
            return [ordered]@{ exitCode = $LASTEXITCODE; output = @($out); error = $null }
        } catch {
            $_ | Out-String | Set-Content -LiteralPath $ErrPath -Encoding UTF8
            return [ordered]@{ exitCode = 1; output = @(); error = $_.Exception.Message }
        }
    } -ArgumentList $projectRoot, $prompt, $claudeArgs, $stderrPath
    $completedJob = Wait-Job -Job $job -Timeout $WorkerTimeoutSeconds
    if (-not $completedJob) {
        Stop-Job -Job $job | Out-Null
        Remove-Job -Job $job -Force | Out-Null
        "Claude worker timed out after $WorkerTimeoutSeconds seconds." | Set-Content -LiteralPath $stderrPath -Encoding UTF8
        $normalized = New-NormalizedResult -Status 'worker_failed' -Mode $Mode -Summary 'Claude worker timed out before returning a result.' -BlockedOn @('worker_timeout') -Artifacts @{ run_dir = $runDir; raw_output = $stdoutPath; raw_error = $stderrPath } -ErrorObject @{ code = 'worker_timeout'; message = "Claude worker timed out after $WorkerTimeoutSeconds seconds." }
        Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'worker_failed' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
    }
    $jobResult = Receive-Job -Job $job
    Remove-Job -Job $job -Force | Out-Null
    $claudeExitCode = [int]$jobResult.exitCode
    $output = @($jobResult.output)
    $output | Set-Content -LiteralPath $stdoutPath -Encoding UTF8

    $status = if ($claudeExitCode -eq 0) { 'success' } else { 'worker_failed' }
    $parsed = $null
    $parseError = $null
    if ($output -and $output.Count -gt 0) {
        try { $parsed = ($output | Out-String | ConvertFrom-Json) } catch { $parseError = $_.Exception.Message }
    }
    $workerResult = $null
    $parsedResult = Get-PropValue -Object $parsed -Name 'result'
    if ($parsedResult) {
        $workerResult = ConvertFrom-WorkerJsonText ([string]$parsedResult)
    }
    if (-not $workerResult -and $parsed) { $workerResult = $parsed }
    if ($parseError -and $status -eq 'success') { $status = 'worker_failed' }
    $subtype = Get-PropValue -Object $parsed -Name 'subtype'
    if (-not $subtype) { $subtype = Get-PropValue -Object $workerResult -Name 'subtype' }
    $isError = Get-PropValue -Object $parsed -Name 'is_error'
    if ($null -eq $isError) { $isError = Get-PropValue -Object $workerResult -Name 'is_error' }
    $claudeErrors = @(ConvertTo-Array (Get-PropValue -Object $parsed -Name 'errors'))
    if ($claudeErrors.Count -eq 0) { $claudeErrors = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'errors')) }
    if (($subtype -eq 'error_max_budget_usd') -or ($isError -eq $true) -or ([string]$isError -eq 'true')) { $status = 'worker_failed' }
    $summaryValue = Get-PropValue -Object $workerResult -Name 'summary'
    if (-not $summaryValue) { $summaryValue = Get-PropValue -Object $workerResult -Name 'result' }
    if (-not $summaryValue) { $summaryValue = Get-PropValue -Object $workerResult -Name 'response' }
    if (-not $summaryValue) { $summaryValue = Get-PropValue -Object $workerResult -Name 'text' }
    if (-not $summaryValue) { $summaryValue = Get-PropValue -Object $workerResult -Name 'content' }
    $summary = ConvertTo-ShortText $summaryValue
    if (-not $summary) {
        $summary = if ($status -eq 'success') { 'Worker completed successfully.' } else { 'Claude worker failed or returned invalid JSON.' }
    }
    $cost = Get-PropValue -Object $parsed -Name 'total_cost_usd'
    $stderrText = ''
    if (Test-Path -LiteralPath $stderrPath) { $stderrText = Get-Content -LiteralPath $stderrPath -Raw }
    $blockedOn = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'blocked_on'))
    $err = if ($parseError) {
        @{ code = 'invalid_worker_json'; message = $parseError }
    } elseif ($status -ne 'success') {
        $errorMessage = if ($claudeErrors.Count -gt 0) { [string]$claudeErrors[0] } elseif ($stderrText) { $stderrText } elseif ($subtype) { [string]$subtype } else { 'Claude worker failed.' }
        if ($subtype -eq 'error_max_budget_usd') {
            $summary = 'Claude worker reached maximum budget.'
            if ($blockedOn -notcontains 'max_budget_usd') { $blockedOn += 'max_budget_usd' }
            @{ code = 'max_budget_usd'; message = $errorMessage }
        } elseif ($subtype -or $isError) {
            @{ code = if ($subtype) { [string]$subtype } else { 'claude_failed' }; message = $errorMessage }
        } else {
            @{ code = 'claude_failed'; message = $errorMessage }
        }
    } else { $null }

    $normalized = New-NormalizedResult -Status $status -Mode $Mode -Summary $summary `
        -FilesRead @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'files_read')) `
        -ChangesMade @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'changes_made')) `
        -CommandsRun @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'commands_run')) `
        -TestsOrChecks @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'tests_or_checks')) `
        -Risks @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'risks')) `
        -BlockedOn $blockedOn `
        -Cost $cost -Artifacts @{ run_dir = $runDir; raw_output = $stdoutPath; raw_error = $stderrPath } -ErrorObject $err
    Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status $status -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath -ClaudeExitCode $claudeExitCode
} catch {
    $message = $_.Exception.Message
    $status = if ($message -match 'TaskFile must be|InputJson must be|Provide either|ContextFiles must be|WorkerTimeoutSeconds|Cannot bind|Mode') { 'invalid_input' } else { 'environment_failed' }
    $message | Set-Content -LiteralPath $stderrPath -Encoding UTF8
    $normalized = New-NormalizedResult -Status $status -Mode $Mode -Summary $message -ErrorObject @{ code = $status; message = $message } -Artifacts @{ run_dir = $runDir }
    Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status $status -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
}

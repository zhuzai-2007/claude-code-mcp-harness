[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("plan", "run", "review")]
    [string] $Mode,
    [Parameter(Position = 1)]
    [string] $Task,
    [string] $TaskFile,
    [string] $InputJson,
    [string] $RunId,
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
    [switch] $MockWorker,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $script:Utf8NoBom
[Console]::OutputEncoding = $script:Utf8NoBom
$OutputEncoding = $script:Utf8NoBom
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
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Test-PropExists {
    param($Object, [Parameter(Mandatory = $true)][string] $Name)
    if ($null -eq $Object) { return $false }
    if ($Object -is [System.Collections.IDictionary]) { return $Object.Contains($Name) }
    return $null -ne $Object.PSObject.Properties[$Name]
}

function ConvertFrom-WorkerJsonText {
    param([AllowNull()][string] $Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $trimmed = $Text.Trim()
    foreach ($candidate in @(Get-WorkerJsonCandidates -Text $trimmed)) {
        try { return ($candidate | ConvertFrom-Json) } catch {}
    }
    return $null
}

function Get-WorkerJsonCandidates {
    param([AllowNull()][string] $Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
    $trimmed = $Text.Trim()
    $candidates = New-Object System.Collections.Generic.List[string]
    $candidates.Add($trimmed)
    foreach ($match in [regex]::Matches($trimmed, '(?s)```(?:json)?\s*(.*?)\s*```')) {
        $value = $match.Groups[1].Value.Trim()
        if (-not [string]::IsNullOrWhiteSpace($value)) { $candidates.Add($value) }
    }
    $firstBrace = $trimmed.IndexOf('{')
    $lastBrace = $trimmed.LastIndexOf('}')
    if ($firstBrace -ge 0 -and $lastBrace -gt $firstBrace) {
        $candidates.Add($trimmed.Substring($firstBrace, $lastBrace - $firstBrace + 1).Trim())
    }
    return @($candidates | Select-Object -Unique)
}

function ConvertFrom-ClaudeCliText {
    param([AllowNull()][string] $Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return @{ parsed = $null; worker = $null; parseError = $null; recovered = $false; events = @() } }
    $parsed = $null
    $parseError = $null
    $events = @()
    try {
        $parsed = ($Text | ConvertFrom-Json)
        $events = @($parsed)
    } catch {
        $parseError = $_.Exception.Message
        $streamParseErrors = @()
        foreach ($line in ($Text -split '\r?\n')) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $events += ($line | ConvertFrom-Json) } catch { $streamParseErrors += $_.Exception.Message }
        }
        $resultEvents = @($events | Where-Object { (Get-PropValue -Object $_ -Name 'type') -eq 'result' })
        if ($resultEvents.Count -gt 0 -and $streamParseErrors.Count -eq 0) {
            $parsed = $resultEvents[-1]
            $parseError = $null
        }
    }
    $worker = $null
    $parsedResult = Get-PropValue -Object $parsed -Name 'result'
    if ($parsedResult) { $worker = ConvertFrom-WorkerJsonText ([string]$parsedResult) }
    if (-not $worker -and $parsed) { $worker = $parsed }
    if (-not $worker) { $worker = ConvertFrom-WorkerJsonText $Text }
    if (-not $worker -and $Text -match '(?s)"result"\s*:\s*"(.*?)"\s*,\s*"(stop_reason|session_id|total_cost_usd)"') {
        $resultText = [regex]::Unescape($Matches[1])
        $worker = ConvertFrom-WorkerJsonText $resultText
        if (-not $worker -and -not [string]::IsNullOrWhiteSpace($resultText)) {
            $worker = [pscustomobject]@{ summary = (ConvertTo-ShortText $resultText); files_read = @(); changes_made = @(); commands_run = @(); tests_or_checks = @(); risks = @('Worker result was recovered from non-strict Claude CLI output.'); blocked_on = @() }
        }
    }
    if (-not $worker -and -not [string]::IsNullOrWhiteSpace($Text)) {
        $worker = [pscustomobject]@{ summary = (ConvertTo-ShortText $Text); files_read = @(); changes_made = @(); commands_run = @(); tests_or_checks = @(); risks = @('Worker returned plain text instead of structured JSON.'); blocked_on = @() }
    }
    return @{ parsed = $parsed; worker = $worker; parseError = $parseError; recovered = ($null -ne $parseError -and $null -ne $worker); events = @($events) }
}

function ConvertTo-ShortText {
    param($Value)
    if ($null -eq $Value) { return $null }
    $text = if ($Value -is [string]) { $Value } else { ($Value | ConvertTo-Json -Depth 4 -Compress) }
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    if ($text.Length -gt 300) { return $text.Substring(0, 300) }
    return $text
}

function ConvertTo-FullText {
    param($Value)
    if ($null -eq $Value) { return $null }
    $text = if ($Value -is [string]) { $Value } else { ($Value | ConvertTo-Json -Depth 12 -Compress) }
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text
}

function Get-ToolAudit {
    param([object[]] $Events)
    $calls = @{}
    $denialIds = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::Ordinal)
    $permissionDenials = @()
    foreach ($event in @($Events)) {
        foreach ($denial in @(ConvertTo-Array (Get-PropValue -Object $event -Name 'permission_denials'))) {
            $permissionDenials += $denial
            $denialId = [string](Get-PropValue -Object $denial -Name 'tool_use_id')
            if (-not [string]::IsNullOrWhiteSpace($denialId)) { [void]$denialIds.Add($denialId) }
        }
        $message = Get-PropValue -Object $event -Name 'message'
        foreach ($block in @(ConvertTo-Array (Get-PropValue -Object $message -Name 'content'))) {
            $blockType = [string](Get-PropValue -Object $block -Name 'type')
            if ($blockType -eq 'tool_use') {
                $id = [string](Get-PropValue -Object $block -Name 'id')
                if ([string]::IsNullOrWhiteSpace($id)) { continue }
                $calls[$id] = [ordered]@{
                    id = $id
                    tool = [string](Get-PropValue -Object $block -Name 'name')
                    input = Get-PropValue -Object $block -Name 'input'
                    result_observed = $false
                    denied = $false
                    succeeded = $false
                }
            } elseif ($blockType -eq 'tool_result') {
                $id = [string](Get-PropValue -Object $block -Name 'tool_use_id')
                if ($calls.ContainsKey($id)) {
                    $isError = Get-PropValue -Object $block -Name 'is_error'
                    $calls[$id].result_observed = $true
                    $calls[$id].succeeded = -not (($isError -eq $true) -or ([string]$isError -eq 'true'))
                }
            }
        }
    }
    foreach ($id in @($calls.Keys)) {
        if ($denialIds.Contains([string]$id)) {
            $calls[$id].denied = $true
            $calls[$id].succeeded = $false
        }
    }
    $records = @($calls.Values)
    $observedTools = @($records | ForEach-Object { $_.tool } | Select-Object -Unique)
    $observedCommands = @()
    $readTargets = @()
    $writeTargets = @()
    $editTargets = @()
    foreach ($record in $records) {
        $input = $record.input
        $tool = [string]$record.tool
        if ($tool -match '^(Bash|Shell)$') {
            $command = [string](Get-PropValue -Object $input -Name 'command')
            if (-not [string]::IsNullOrWhiteSpace($command)) { $observedCommands += $command }
        }
        $target = $null
        foreach ($name in @('file_path', 'path')) {
            $candidate = [string](Get-PropValue -Object $input -Name $name)
            if (-not [string]::IsNullOrWhiteSpace($candidate)) { $target = $candidate; break }
        }
        if ($tool -match '^(Read|Glob|Grep|LS)$' -and $target) { $readTargets += $target }
        if ($tool -match '^(Write)$' -and $target) { $writeTargets += $target }
        if ($tool -match '^(Edit|MultiEdit)$' -and $target) { $editTargets += $target }
    }
    return [ordered]@{
        schema_version = 1
        events_present = (@($Events).Count -gt 0)
        tool_calls = @($records)
        observed_tools = @($observedTools)
        observed_commands = @($observedCommands)
        permission_denials = @($permissionDenials)
        file_targets = [ordered]@{ read = @($readTargets); write = @($writeTargets); edit = @($editTargets) }
    }
}

function Test-TextMentionsShellCommand {
    param([string] $Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    return $Text -match '(?i)(`[^`]*(?:ls\b|test\s+-[def]|git\s+(?:status|diff)|npm\s+test|pytest|powershell|node\s+)[^`]*`|\b(?:ls\s+-|test\s+-[def]|git\s+(?:status|diff)|npm\s+test|pytest)\b)'
}

function Test-TextMentionsFileEvidence {
    param([string] $Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    return $Text -match '(?i)\b(read|inspect(?:ed)?|exist(?:s|ence)?|file|director(?:y|ies)|path|glob|grep|ls)\b|读取|检查|文件|目录|路径|存在'
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
    $json = $Value | ConvertTo-Json -Depth $Depth
    [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $script:Utf8NoBom)
}

function Write-Utf8Text {
    param([Parameter(Mandatory = $true)][string] $Path, [AllowNull()][string] $Text)
    [System.IO.File]::WriteAllText($Path, [string]$Text, $script:Utf8NoBom)
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
        [object[]] $ObservedTools = @(),
        [object[]] $ObservedCommands = @(),
        [object[]] $PermissionDenials = @(),
        $ObservedFileTargets = $null,
        [object[]] $AuditIssues = @(),
        [object[]] $SupervisorNotes = @(),
        [string] $ArtifactStatus = $null,
        $Cost = $null,
        [hashtable] $Artifacts = @{},
        $ErrorObject = $null
    )
    $normalizedError = $null
    if ($null -ne $ErrorObject) {
        $normalizedError = [ordered]@{
            code = [string](Get-PropValue -Object $ErrorObject -Name 'code')
            message = [string](Get-PropValue -Object $ErrorObject -Name 'message')
        }
    }
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
        observed_tools = @($ObservedTools)
        observed_commands = @($ObservedCommands)
        permission_denials = @($PermissionDenials)
        observed_file_targets = $ObservedFileTargets
        audit_issues = @($AuditIssues)
        supervisor_notes = @($SupervisorNotes)
        artifact_status = $ArtifactStatus
        cost = $Cost
        artifacts = $Artifacts
        error = $normalizedError
    }
}

function Add-LedgerEntry {
    param(
        [string] $ProjectRoot,
        [string] $RunId,
        [string] $RunDir,
        [string] $Mode,
        [string] $Status,
        $Normalized,
        [string] $ApprovedBy,
        [string] $ApprovalReason,
        [bool] $AllowNetwork,
        [bool] $AllowDependencyInstall,
        [bool] $AllowGitWrite,
        [bool] $AllowRecursiveDelete,
        [object[]] $ExternalAllowDirs,
        [object[]] $ContextFiles,
        [decimal] $BudgetUsd,
        [int] $WorkerTimeoutSeconds
    )
    try {
        $ledgerDir = Join-Path $ProjectRoot '.agent-runs'
        New-Item -ItemType Directory -Force -Path $ledgerDir | Out-Null
        $entry = [ordered]@{
            recordedAt = (Get-Date).ToString('o')
            runId = $RunId
            mode = $Mode
            status = $Status
            runDir = $RunDir
            summary = Get-PropValue -Object $Normalized -Name 'summary'
            changes_made = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'changes_made'))
            commands_run = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'commands_run'))
            tests_or_checks = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'tests_or_checks'))
            risks = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'risks'))
            blocked_on = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'blocked_on'))
            supervisor_notes = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'supervisor_notes'))
            artifact_status = Get-PropValue -Object $Normalized -Name 'artifact_status'
            cost = Get-PropValue -Object $Normalized -Name 'cost'
            approval = @{ approvedBy = Protect-Text $ApprovedBy; approvalReason = Protect-Text $ApprovalReason }
            allowed_actions = @{
                network = $AllowNetwork
                dependency_install = $AllowDependencyInstall
                git_write = $AllowGitWrite
                recursive_delete = $AllowRecursiveDelete
                external_allow_dirs = @($ExternalAllowDirs)
                context_files = @($ContextFiles)
            }
            budgetUsd = $BudgetUsd
            workerTimeoutSeconds = $WorkerTimeoutSeconds
            error = Get-PropValue -Object $Normalized -Name 'error'
        }
        $ledgerLine = ($entry | ConvertTo-Json -Depth 12 -Compress) + [Environment]::NewLine
        [System.IO.File]::AppendAllText((Join-Path $ledgerDir 'project-ledger.jsonl'), $ledgerLine, $script:Utf8NoBom)
    } catch {
        # Ledger writes must not change the worker exit status.
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
    Add-LedgerEntry -ProjectRoot $ProjectRoot -RunId $RunId -RunDir $RunDir -Mode $Mode -Status $Status -Normalized $Normalized -ApprovedBy $script:ApprovedBy -ApprovalReason $script:ApprovalReason -AllowNetwork ([bool]$script:AllowNetwork) -AllowDependencyInstall ([bool]$script:AllowDependencyInstall) -AllowGitWrite ([bool]$script:AllowGitWrite) -AllowRecursiveDelete ([bool]$script:AllowRecursiveDelete) -ExternalAllowDirs @($script:resolvedAllowDirs) -ContextFiles @($script:resolvedContextFiles) -BudgetUsd $script:BudgetUsd -WorkerTimeoutSeconds $script:WorkerTimeoutSeconds
    Write-Host "Worker run complete."
    Write-Host "RunId: $RunId"
    Write-Host "Mode: $Mode"
    Write-Host "Run dir: $RunDir"
    Write-Host "Status: $Status"
    exit $ExitCodes[$Status]
}

function New-RunDirectory {
    param([string] $AgentsRoot, [string] $ProjectRoot, [string] $RequestedRunId)
    $runId = if ($RequestedRunId) { $RequestedRunId } else { (Get-Date).ToString("yyyyMMdd-HHmmss-fff") }
    if ($runId -notmatch '^\d{8}-\d{6}-\d{3}$') { throw "RunId must use yyyyMMdd-HHmmss-fff format." }
    $preferredRunRoot = Join-Path $AgentsRoot 'runs'
    $fallbackRunRoot = Join-Path $ProjectRoot '.agent-runs'
    if ((Test-Path -LiteralPath (Join-Path $preferredRunRoot $runId)) -or (Test-Path -LiteralPath (Join-Path $fallbackRunRoot $runId))) {
        throw "RunId already exists: $runId"
    }
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
$runInfo = New-RunDirectory -AgentsRoot $agentsRoot -ProjectRoot $projectRoot -RequestedRunId $RunId
$runId = $runInfo.runId
$runDir = $runInfo.runDir
$stdoutPath = Join-Path $runDir 'claude-output.json'
$eventStreamPath = Join-Path $runDir 'claude-events.jsonl'
$stderrPath = Join-Path $runDir 'claude-error.txt'
$toolEventsPath = Join-Path $runDir 'tool-events.json'
$script:resolvedAllowDirs = @()
$script:resolvedContextFiles = @()
Save-Json -Value ([ordered]@{ runId = $runId; mode = $Mode; projectRoot = $projectRoot; startedAt = (Get-Date).ToString('o'); status = 'in_progress' }) -Path (Join-Path $runDir 'in_progress.json') -Depth 5

try {
    $policyPath = Join-Path $agentsRoot 'policy.json'
    if (-not (Test-Path -LiteralPath $policyPath)) { throw "Missing policy file: $policyPath" }
    $policy = Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $policy.modes.$Mode) { throw "Mode '$Mode' is not configured in policy.json." }
    $modePolicy = $policy.modes.$Mode
    $localConfig = $null
    $localConfigPath = Join-Path $agentsRoot 'local.config.json'
    if (Test-Path -LiteralPath $localConfigPath) {
        $localConfig = Get-Content -LiteralPath $localConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    if ($InputJson) {
        $inputPath = Resolve-FullPath $InputJson
        if (-not (Test-IsPathInside -Child $inputPath -Parent $projectRoot)) { throw "InputJson must be inside the project root. InputJson=$inputPath ProjectRoot=$projectRoot" }
        $input = Get-Content -LiteralPath $inputPath -Raw -Encoding UTF8 | ConvertFrom-Json
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
        if ($props['mockWorker']) { $MockWorker = [bool]$props['mockWorker'].Value }
    }

    if ($WorkerTimeoutSeconds -lt 1) { throw 'WorkerTimeoutSeconds must be 1 or higher.' }
    if ([string]::IsNullOrWhiteSpace($Task) -and [string]::IsNullOrWhiteSpace($TaskFile)) { throw 'Provide either -Task, -TaskFile, or -InputJson with task/taskFile.' }
    if ($TaskFile) {
        $taskFilePath = Resolve-FullPath $TaskFile
        if (-not (Test-IsPathInside -Child $taskFilePath -Parent $projectRoot)) { throw "TaskFile must be inside the project root. TaskFile=$taskFilePath ProjectRoot=$projectRoot" }
        $Task = Get-Content -LiteralPath $taskFilePath -Raw -Encoding UTF8
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
    $script:resolvedAllowDirs = @($resolvedAllowDirs)
    $script:resolvedContextFiles = @($resolvedContextFiles)

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
- On Windows, use project-relative paths with forward slashes when a Bash/MSYS tool is unavoidable.
- Never pass a drive-letter path such as D:\path\to\file to Bash, and never use commands such as mkdir -p with a Windows absolute path.
- Prefer Read, Write, and Edit for file-only tasks. Do not use Bash merely to create a directory for a file write.

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
        model = if ($Model) { $Model } else { '<claude-default>' }; bare = [bool]$effectiveBare; dryRun = [bool]$DryRun; mockWorker = [bool]$MockWorker
        workerTimeoutSeconds = $WorkerTimeoutSeconds
        approvedBy = Protect-Text $ApprovedBy; approvalReason = Protect-Text $ApprovalReason
        externalAllowDirs = $resolvedAllowDirs; contextFiles = $resolvedContextFiles; maxFilesRead = $MaxFilesRead; maxCommands = $MaxCommands
        allowNetwork = [bool]$AllowNetwork; allowDependencyInstall = [bool]$AllowDependencyInstall; allowGitWrite = [bool]$AllowGitWrite; allowRecursiveDelete = [bool]$AllowRecursiveDelete
    }
    Save-Json -Value $meta -Path (Join-Path $runDir 'meta.json') -Depth 10
    Write-Utf8Text -Path (Join-Path $runDir 'prompt.txt') -Text $prompt
    Write-Utf8Text -Path (Join-Path $runDir 'system-prompt.txt') -Text (Protect-Text $systemPrompt)

    if ($violations.Count -gt 0) {
        $normalized = New-NormalizedResult -Status 'policy_blocked' -Mode $Mode -Summary 'Worker run blocked by local policy before invoking Claude.' -BlockedOn $violations -Artifacts @{ run_dir = $runDir }
        Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'policy_blocked' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
    }

    $claudeArgs = @()
    if ($effectiveBare) { $claudeArgs += '--bare' }
    $claudeArgs += @('-p', '--permission-mode', [string]$modePolicy.permissionMode, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', ([string]$BudgetUsd), '--system-prompt', $systemPrompt)
    if ($modePolicy.allowedTools -and $modePolicy.allowedTools.Count -gt 0) { $claudeArgs += '--allowedTools'; $claudeArgs += ($modePolicy.allowedTools -join ',') }
    if ($modePolicy.disallowedTools -and $modePolicy.disallowedTools.Count -gt 0) { $claudeArgs += '--disallowedTools'; $claudeArgs += ($modePolicy.disallowedTools -join ',') }
    if ($Model) { $claudeArgs += '--model'; $claudeArgs += $Model }
    foreach ($dir in $resolvedAllowDirs) { $claudeArgs += '--add-dir'; $claudeArgs += $dir }
    $commandLinePreview = 'claude ' + (($claudeArgs | ForEach-Object { if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ') + ' < prompt.txt'
    Write-Utf8Text -Path (Join-Path $runDir 'command.txt') -Text $commandLinePreview

    if ($DryRun) {
        $normalized = New-NormalizedResult -Status 'success' -Mode $Mode -Summary 'Dry run only. Claude was not invoked.' -Artifacts @{ run_dir = $runDir; command = (Join-Path $runDir 'command.txt') }
        Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'success' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath -ClaudeExitCode 0
    }

    if ($MockWorker) {
        $mockBlockedOn = @()
        if (-not [string]::IsNullOrWhiteSpace($env:CLAUDE_TASK_MOCK_BLOCKED_ON)) {
            $mockBlockedOn = @($env:CLAUDE_TASK_MOCK_BLOCKED_ON)
        }
        $mockWorkerResult = [ordered]@{
            summary = "Mock worker completed successfully."
            files_read = @()
            changes_made = @()
            commands_run = @()
            tests_or_checks = @("mock worker path exercised")
            risks = @()
            blocked_on = $mockBlockedOn
        }
        $mockCliResult = [ordered]@{
            type = 'result'
            subtype = 'mock_success'
            is_error = $false
            result = ($mockWorkerResult | ConvertTo-Json -Depth 8 -Compress)
            total_cost_usd = 0
        }
        $claudeExitCode = 0
        $mockCliJson = ($mockCliResult | ConvertTo-Json -Depth 10 -Compress)
        $output = if ($env:CLAUDE_TASK_MOCK_NON_STRICT -eq '1') { @('non-strict mock prefix', $mockCliJson) } else { @($mockCliJson) }
        Write-Utf8Text -Path $stderrPath -Text "Mock worker enabled; Claude Code was not invoked."
    } else {
        $claude = Get-Command claude -ErrorAction SilentlyContinue
        if (-not $claude) {
            $normalized = New-NormalizedResult -Status 'environment_failed' -Mode $Mode -Summary "Claude Code command 'claude' was not found on PATH." -ErrorObject @{ code = 'claude_not_found'; message = "Claude Code command 'claude' was not found on PATH." } -Artifacts @{ run_dir = $runDir }
            Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'environment_failed' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
        }

        $job = Start-Job -ScriptBlock {
            param($ProjectRoot, $PromptText, $ArgsForClaude, $ErrPath)
            Set-Location -LiteralPath $ProjectRoot
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [Console]::InputEncoding = $utf8NoBom
            [Console]::OutputEncoding = $utf8NoBom
            $OutputEncoding = $utf8NoBom
            try {
                $out = $PromptText | & claude @ArgsForClaude 2> $ErrPath
                return [ordered]@{ exitCode = $LASTEXITCODE; output = @($out); error = $null }
            } catch {
                [System.IO.File]::WriteAllText($ErrPath, ($_ | Out-String), $utf8NoBom)
                return [ordered]@{ exitCode = 1; output = @(); error = $_.Exception.Message }
            }
        } -ArgumentList $projectRoot, $prompt, $claudeArgs, $stderrPath
        $completedJob = Wait-Job -Job $job -Timeout $WorkerTimeoutSeconds
        if (-not $completedJob) {
            Stop-Job -Job $job | Out-Null
            Remove-Job -Job $job -Force | Out-Null
            Write-Utf8Text -Path $stderrPath -Text "Claude worker timed out after $WorkerTimeoutSeconds seconds."
            $normalized = New-NormalizedResult -Status 'worker_failed' -Mode $Mode -Summary 'Claude worker timed out before returning a result.' -BlockedOn @('worker_timeout') -SupervisorNotes @('No structured worker result was returned before timeout. Check the Claude Code provider, authentication, model mapping, and non-interactive execution path.') -ArtifactStatus 'worker_failed_no_artifact_claim' -Artifacts @{ run_dir = $runDir; raw_output = $stdoutPath; raw_error = $stderrPath } -ErrorObject @{ code = 'worker_timeout'; message = "Claude worker timed out after $WorkerTimeoutSeconds seconds." }
            Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'worker_failed' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
        }
        $jobResult = Receive-Job -Job $job
        Remove-Job -Job $job -Force | Out-Null
        $claudeExitCode = [int]$jobResult.exitCode
        $output = @($jobResult.output)
    }
    Write-Utf8Text -Path $eventStreamPath -Text ($output -join [Environment]::NewLine)

    $status = if ($claudeExitCode -eq 0) { 'success' } else { 'worker_failed' }
    $parseInfo = ConvertFrom-ClaudeCliText ($output | Out-String)
    $parsed = $parseInfo.parsed
    $workerResult = $parseInfo.worker
    $streamEvents = @($parseInfo.events)
    $parseError = $parseInfo.parseError
    $recoveredWorkerOutput = [bool]$parseInfo.recovered
    if ($null -ne $parsed) {
        Save-Json -Value $parsed -Path $stdoutPath -Depth 20
    } else {
        Write-Utf8Text -Path $stdoutPath -Text ($output -join [Environment]::NewLine)
    }
    if ($parseError -and -not $recoveredWorkerOutput -and $status -eq 'success') { $status = 'worker_failed' }
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
    $summary = if ($recoveredWorkerOutput) { ConvertTo-ShortText $summaryValue } else { ConvertTo-FullText $summaryValue }
    if (-not $summary) {
        $summary = if ($status -eq 'success') { 'Worker completed successfully.' } else { 'Claude worker failed or returned invalid JSON.' }
    }
    $cost = Get-PropValue -Object $parsed -Name 'total_cost_usd'
    $stderrText = ''
    if (Test-Path -LiteralPath $stderrPath) { $stderrText = Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8 }
    $blockedOn = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'blocked_on'))
    if ($status -eq 'success' -and $blockedOn.Count -gt 0) {
        $status = 'worker_failed'
    }
    $risksFromWorker = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'risks'))
    if ($recoveredWorkerOutput -and ($risksFromWorker -notcontains 'Recovered worker result from non-strict Claude CLI output.')) {
        $risksFromWorker += 'Recovered worker result from non-strict Claude CLI output.'
    }
    $filesRead = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'files_read'))
    $changesMade = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'changes_made'))
    $commandsRun = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'commands_run'))
    $testsOrChecks = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'tests_or_checks'))
    $toolAudit = Get-ToolAudit -Events $streamEvents
    Save-Json -Value $toolAudit -Path $toolEventsPath -Depth 20
    $successfulCalls = @($toolAudit.tool_calls | Where-Object { $_.succeeded -eq $true -and $_.denied -ne $true })
    $successfulTools = @($successfulCalls | ForEach-Object { $_.tool } | Select-Object -Unique)
    $successfulCommands = @($successfulCalls | Where-Object { $_.tool -match '^(Bash|Shell)$' } | ForEach-Object { [string](Get-PropValue -Object $_.input -Name 'command') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $successfulReadCalls = @($successfulCalls | Where-Object { $_.tool -match '^(Read|Glob|Grep|LS)$' })
    $successfulWriteCalls = @($successfulCalls | Where-Object { $_.tool -match '^(Write|Edit|MultiEdit)$' })
    $auditIssues = @()
    foreach ($requiredField in @('summary', 'files_read', 'changes_made', 'commands_run', 'tests_or_checks', 'risks', 'blocked_on')) {
        if (-not (Test-PropExists -Object $workerResult -Name $requiredField)) {
            $auditIssues += "missing_required_field:$requiredField"
        }
    }
    if ($recoveredWorkerOutput) {
        $auditIssues += 'non_strict_output_recovered'
    }
    if (-not $MockWorker) {
        if (($Mode -eq 'plan' -or $Mode -eq 'review') -and (($filesRead.Count + $commandsRun.Count + $testsOrChecks.Count) -eq 0)) {
            $auditIssues += 'missing_read_or_check_evidence'
        }
        if (($Mode -eq 'run') -and ($changesMade.Count -eq 0)) {
            $auditIssues += 'missing_change_evidence'
        }
        if (($Mode -eq 'run') -and ($testsOrChecks.Count -eq 0)) {
            $auditIssues += 'missing_test_or_check_evidence'
        }
        if ($changesMade.Count -eq 0 -and $successfulWriteCalls.Count -gt 0) {
            $auditIssues += 'file_audit_mismatch:observed_write_not_reported'
        }
        if ($changesMade.Count -gt 0 -and $successfulWriteCalls.Count -eq 0) {
            $auditIssues += 'file_audit_mismatch:reported_change_not_observed'
        }
        if ($commandsRun.Count -eq 0 -and $successfulCommands.Count -gt 0) {
            $auditIssues += 'command_audit_mismatch:observed_shell_command_not_reported'
        }
        foreach ($reportedCommand in $commandsRun) {
            $reported = [string]$reportedCommand
            if (-not ($successfulCommands | Where-Object { $_ -eq $reported -or $_ -like "*$reported*" -or $reported -like "*$_*" })) {
                $auditIssues += 'command_audit_mismatch:reported_command_not_observed'
                break
            }
        }
        foreach ($reportedFile in $filesRead) {
            $reported = ([string]$reportedFile).Replace('\', '/').TrimStart('./')
            $matched = $false
            foreach ($call in $successfulReadCalls) {
                foreach ($field in @('file_path', 'path')) {
                    $target = ([string](Get-PropValue -Object $call.input -Name $field)).Replace('\', '/').TrimStart('./')
                    if ($target -and ($target -eq $reported -or $target.EndsWith('/' + $reported) -or $reported.EndsWith('/' + $target))) { $matched = $true }
                }
            }
            if (-not $matched) { $auditIssues += 'file_audit_mismatch:reported_file_read_not_observed'; break }
        }
        foreach ($checkValue in $testsOrChecks) {
            $check = [string]$checkValue
            $verified = $true
            if (Test-TextMentionsShellCommand $check) {
                $verified = $false
                if ($check -match '(?i)\bls\b' -and ($successfulTools -contains 'LS')) { $verified = $true }
                if (-not $verified -and ($successfulCommands | Where-Object {
                    ($check -match '(?i)\bls\b' -and $_ -match '(?i)\bls\b') -or
                    ($check -match '(?i)test\s+-[def]' -and $_ -match '(?i)test\s+-[def]') -or
                    ($check -match '(?i)git\s+status' -and $_ -match '(?i)git\s+status') -or
                    ($check -match '(?i)git\s+diff' -and $_ -match '(?i)git\s+diff')
                })) { $verified = $true }
            } elseif (Test-TextMentionsFileEvidence $check) {
                $verified = $successfulReadCalls.Count -gt 0
            } elseif ($successfulCalls.Count -eq 0) {
                $verified = $false
            }
            if (-not $verified) { $auditIssues += 'unverifiable_check_evidence'; break }
        }
        if ($toolAudit.permission_denials.Count -gt 0 -and $testsOrChecks.Count -gt 0 -and $successfulCalls.Count -eq 0) {
            if ($auditIssues -notcontains 'unverifiable_check_evidence') { $auditIssues += 'unverifiable_check_evidence' }
        }
    }
    if ($status -eq 'success' -and $auditIssues.Count -gt 0) {
        $status = 'worker_failed'
    }
    $err = if ($auditIssues.Count -gt 0) {
        @{ code = 'audit_validation_failed'; message = ($auditIssues -join ', ') }
    } elseif ($parseError -and -not $recoveredWorkerOutput) {
        @{ code = 'invalid_worker_json'; message = $parseError }
    } elseif ($status -ne 'success') {
        $errorMessage = if ($claudeErrors.Count -gt 0) { [string]$claudeErrors[0] } elseif ($stderrText) { $stderrText } elseif ($subtype) { [string]$subtype } else { 'Claude worker failed.' }
        if ($subtype -eq 'error_max_budget_usd') {
            $summary = 'Claude worker reached maximum budget.'
            if ($blockedOn -notcontains 'max_budget_usd') { $blockedOn += 'max_budget_usd' }
            @{ code = 'max_budget_usd'; message = $errorMessage }
        } elseif ($subtype -or $isError) {
            $errorCode = if ($subtype) { [string]$subtype } else { 'claude_failed' }
            @{ code = $errorCode; message = $errorMessage }
        } else {
            @{ code = 'claude_failed'; message = $errorMessage }
        }
    } else { $null }
    $supervisorNotes = @()
    $artifactStatus = if ($status -eq 'success') { 'worker_reported_success' } else { 'worker_failed_no_artifact_claim' }
    if ($auditIssues.Count -gt 0) {
        $artifactStatus = 'worker_output_needs_review'
        $supervisorNotes += "Worker output did not meet the audit contract: $($auditIssues -join ', ')."
    }
    if ($status -ne 'success' -and (($filesRead.Count -gt 0) -or ($changesMade.Count -gt 0) -or ($testsOrChecks.Count -gt 0))) {
        $artifactStatus = 'unvalidated_partial_artifacts_possible'
        $supervisorNotes += 'Worker failed but reported files, changes, or checks. Treat artifacts as untrusted partial output until Codex validates them independently.'
        if ($risksFromWorker -notcontains 'Partial artifacts may exist despite worker failure.') {
            $risksFromWorker += 'Partial artifacts may exist despite worker failure.'
        }
    }

    $normalized = New-NormalizedResult -Status $status -Mode $Mode -Summary $summary `
        -FilesRead $filesRead `
        -ChangesMade $changesMade `
        -CommandsRun $commandsRun `
        -TestsOrChecks $testsOrChecks `
        -Risks $risksFromWorker `
        -BlockedOn $blockedOn `
        -ObservedTools @($toolAudit.observed_tools) `
        -ObservedCommands @($toolAudit.observed_commands) `
        -PermissionDenials @($toolAudit.permission_denials) `
        -ObservedFileTargets $toolAudit.file_targets `
        -AuditIssues $auditIssues `
        -SupervisorNotes $supervisorNotes `
        -ArtifactStatus $artifactStatus `
        -Cost $cost -Artifacts @{ run_dir = $runDir; raw_output = $stdoutPath; raw_events = $eventStreamPath; raw_error = $stderrPath; tool_events = $toolEventsPath } -ErrorObject $err
    Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status $status -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath -ClaudeExitCode $claudeExitCode
} catch {
    $message = $_.Exception.Message
    $status = if ($message -match 'TaskFile must be|InputJson must be|Provide either|ContextFiles must be|WorkerTimeoutSeconds|Cannot bind|Mode') { 'invalid_input' } else { 'environment_failed' }
    Write-Utf8Text -Path $stderrPath -Text $message
    $normalized = New-NormalizedResult -Status $status -Mode $Mode -Summary $message -ErrorObject @{ code = $status; message = $message } -Artifacts @{ run_dir = $runDir }
    Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status $status -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
}

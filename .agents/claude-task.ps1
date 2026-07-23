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
    [string] $ResourceProfile,
    [string] $Model,
    [string[]] $AllowDir = @(),
    [string[]] $ContextFiles = @(),
    [string] $ProjectContextSnapshotFile,
    [int] $MaxTurns = -1,
    [int] $MaxFilesRead = -1,
    [int] $MaxCommands = -1,
    [int] $WorkerTimeoutSeconds = -1,
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
$maxTurnsProvided = $PSBoundParameters.ContainsKey('MaxTurns')
$maxFilesReadProvided = $PSBoundParameters.ContainsKey('MaxFilesRead')
$maxCommandsProvided = $PSBoundParameters.ContainsKey('MaxCommands')
$workerTimeoutProvided = $PSBoundParameters.ContainsKey('WorkerTimeoutSeconds')
$script:ResourceProfileName = if ($ResourceProfile) { $ResourceProfile } else { $null }
$script:ResourceLimits = $null

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

function ConvertTo-AuditPath {
    param($Value)
    $normalized = ([string]$Value).Replace('\', '/')
    while ($normalized.StartsWith('./', [System.StringComparison]::Ordinal)) {
        $normalized = $normalized.Substring(2)
    }
    return $normalized
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
    $callOrder = New-Object System.Collections.Generic.List[string]
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
                if (-not $calls.ContainsKey($id)) { [void]$callOrder.Add($id) }
                $calls[$id] = [ordered]@{
                    id = $id
                    call_index = $callOrder.IndexOf($id)
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
    $records = @($callOrder | ForEach-Object { $calls[[string]$_] })
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

function Get-CapabilityDiagnostics {
    param([object[]] $Events, [object[]] $AllowedTools)
    $initEvent = @($Events | Where-Object {
        (Get-PropValue -Object $_ -Name 'type') -eq 'system' -and (Get-PropValue -Object $_ -Name 'subtype') -eq 'init'
    } | Select-Object -First 1)
    $allowed = @($AllowedTools | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    if ($initEvent.Count -eq 0) {
        return [ordered]@{
            initObserved = $false
            allowedTools = $allowed
            actualTools = @()
            missingAllowedTools = @()
            directoryDiscoveryAvailable = $null
            mismatch = $false
        }
    }
    $actual = @(ConvertTo-Array (Get-PropValue -Object $initEvent[0] -Name 'tools') | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    $missing = @($allowed | Where-Object { $actual -notcontains $_ })
    $discovery = @($actual | Where-Object { $_ -in @('Glob', 'LS') })
    return [ordered]@{
        initObserved = $true
        allowedTools = $allowed
        actualTools = $actual
        missingAllowedTools = $missing
        directoryDiscoveryAvailable = ($discovery.Count -gt 0)
        mismatch = ($missing.Count -gt 0)
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
        [object[]] $ProposedChanges = @(),
        [object[]] $ChangesMade = @(),
        [object[]] $CommandsRun = @(),
        [object[]] $TestsOrChecks = @(),
        [object[]] $Risks = @(),
        [object[]] $BlockedOn = @(),
        $RunResult = $null,
        [object[]] $ObservedTools = @(),
        [object[]] $ObservedCommands = @(),
        [object[]] $PermissionDenials = @(),
        $ObservedFileTargets = $null,
        [object[]] $AuditIssues = @(),
        [object[]] $SupervisorNotes = @(),
        $CapabilityDiagnostics = $null,
        [string] $ArtifactStatus = $null,
        $Cost = $null,
        $ResourceUsage = $null,
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
        proposed_changes = @($ProposedChanges)
        changes_made = @($ChangesMade)
        commands_run = @($CommandsRun)
        tests_or_checks = @($TestsOrChecks)
        risks = @($Risks)
        blocked_on = @($BlockedOn)
        run_result = $RunResult
        observed_tools = @($ObservedTools)
        observed_commands = @($ObservedCommands)
        permission_denials = @($PermissionDenials)
        observed_file_targets = $ObservedFileTargets
        audit_issues = @($AuditIssues)
        supervisor_notes = @($SupervisorNotes)
        capability_diagnostics = $CapabilityDiagnostics
        artifact_status = $ArtifactStatus
        cost = $Cost
        resource_profile = $script:ResourceProfileName
        resource_limits = $script:ResourceLimits
        resource_usage = $ResourceUsage
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
            proposed_changes = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'proposed_changes'))
            commands_run = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'commands_run'))
            tests_or_checks = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'tests_or_checks'))
            risks = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'risks'))
            blocked_on = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'blocked_on'))
            run_result = Get-PropValue -Object $Normalized -Name 'run_result'
            supervisor_notes = @(ConvertTo-Array (Get-PropValue -Object $Normalized -Name 'supervisor_notes'))
            capability_diagnostics = Get-PropValue -Object $Normalized -Name 'capability_diagnostics'
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
            resourceProfile = $script:ResourceProfileName
            resourceLimits = $script:ResourceLimits
            resourceUsage = Get-PropValue -Object $Normalized -Name 'resource_usage'
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
$projectContextSnapshotPath = $null
if (-not [string]::IsNullOrWhiteSpace($ProjectContextSnapshotFile)) {
    $snapshotSource = Resolve-FullPath $ProjectContextSnapshotFile
    if (-not (Test-IsPathInside -Child $snapshotSource -Parent $projectRoot)) { throw "ProjectContextSnapshotFile must be inside the project root. File=$snapshotSource ProjectRoot=$projectRoot" }
    if (-not (Test-Path -LiteralPath $snapshotSource -PathType Leaf)) { throw "ProjectContextSnapshotFile was not found: $snapshotSource" }
    $projectContextSnapshotPath = Join-Path $runDir 'project-context-snapshot.json'
    Copy-Item -LiteralPath $snapshotSource -Destination $projectContextSnapshotPath -Force
    $ContextFiles += $projectContextSnapshotPath
}
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
    if ($InputJson) {
        $inputPath = Resolve-FullPath $InputJson
        if (-not (Test-IsPathInside -Child $inputPath -Parent $projectRoot)) { throw "InputJson must be inside the project root. InputJson=$inputPath ProjectRoot=$projectRoot" }
        $input = Get-Content -LiteralPath $inputPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $props = $input.PSObject.Properties
        if ($props['task']) { $Task = [string]$props['task'].Value }
        if ($props['taskFile']) { $TaskFile = [string]$props['taskFile'].Value }
        if ($props['budgetUsd'] -and -not $budgetProvided) { $BudgetUsd = [decimal]$props['budgetUsd'].Value; $budgetProvided = $true }
        if ($props['maxBudgetUsd'] -and -not $maxBudgetProvided) { $MaxBudgetUsd = [decimal]$props['maxBudgetUsd'].Value; $maxBudgetProvided = $true }
        if ($props['resourceProfile'] -and -not $ResourceProfile) { $ResourceProfile = [string]$props['resourceProfile'].Value }
        if ($props['model'] -and -not $Model) { $Model = [string]$props['model'].Value }
        if ($props['contextFiles']) { $ContextFiles = @($props['contextFiles'].Value) }
        if ($props['maxTurns'] -and -not $maxTurnsProvided) { $MaxTurns = [int]$props['maxTurns'].Value; $maxTurnsProvided = $true }
        if ($props['maxFilesRead'] -and -not $maxFilesReadProvided) { $MaxFilesRead = [int]$props['maxFilesRead'].Value; $maxFilesReadProvided = $true }
        if ($props['maxCommands'] -and -not $maxCommandsProvided) { $MaxCommands = [int]$props['maxCommands'].Value; $maxCommandsProvided = $true }
        if ($props['workerTimeoutSeconds'] -and -not $workerTimeoutProvided) { $WorkerTimeoutSeconds = [int]$props['workerTimeoutSeconds'].Value; $workerTimeoutProvided = $true }
        if ($props['approvedBy'] -and -not $ApprovedBy) { $ApprovedBy = [string]$props['approvedBy'].Value }
        if ($props['approvalReason'] -and -not $ApprovalReason) { $ApprovalReason = [string]$props['approvalReason'].Value }
        if ($props['mockWorker']) { $MockWorker = [bool]$props['mockWorker'].Value }
    }

    if ([string]::IsNullOrWhiteSpace($Task) -and [string]::IsNullOrWhiteSpace($TaskFile)) { throw 'Provide either -Task, -TaskFile, or -InputJson with task/taskFile.' }
    if ($TaskFile) {
        $taskFilePath = Resolve-FullPath $TaskFile
        if (-not (Test-IsPathInside -Child $taskFilePath -Parent $projectRoot)) { throw "TaskFile must be inside the project root. TaskFile=$taskFilePath ProjectRoot=$projectRoot" }
        $Task = Get-Content -LiteralPath $taskFilePath -Raw -Encoding UTF8
    }

    if (($Mode -eq 'plan' -or $Mode -eq 'review') -and -not (Test-ReadonlyTools -ModePolicy $modePolicy)) { throw "Policy error: mode '$Mode' includes write-capable tools." }
    $resourceProfilesPath = Join-Path $agentsRoot 'resource-profiles.json'
    if (-not (Test-Path -LiteralPath $resourceProfilesPath)) { throw "Missing resource profile file: $resourceProfilesPath" }
    $resourceProfiles = Get-Content -LiteralPath $resourceProfilesPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($ResourceProfile)) { $ResourceProfile = [string]$resourceProfiles.defaultProfile }
    $profileDefinition = $resourceProfiles.profiles.PSObject.Properties[$ResourceProfile]
    if ($null -eq $profileDefinition) { throw "Unknown resource profile: $ResourceProfile" }
    $profileLimits = $profileDefinition.Value
    $hardLimits = $resourceProfiles.hardLimits
    $script:ResourceProfileName = $ResourceProfile

    if ((-not $maxBudgetProvided) -and $budgetProvided -and $BudgetUsd -ge 0) { $MaxBudgetUsd = $BudgetUsd; $maxBudgetProvided = $true }
    if (-not $maxBudgetProvided) { $MaxBudgetUsd = [decimal]$profileLimits.maxBudgetUsd }
    if (-not $maxTurnsProvided) { $MaxTurns = [int]$profileLimits.maxTurns }
    if (-not $maxFilesReadProvided) { $MaxFilesRead = [int]$profileLimits.maxFilesRead }
    if (-not $maxCommandsProvided) { $MaxCommands = [int]$profileLimits.maxCommands }
    if (-not $workerTimeoutProvided) { $WorkerTimeoutSeconds = [int]$profileLimits.timeoutSeconds }
    if ($MaxBudgetUsd -le 0) { throw "MaxBudgetUsd must be a positive number." }
    if ($MaxBudgetUsd -gt [decimal]$hardLimits.maxBudgetUsd) { throw "MaxBudgetUsd must be less than or equal to $($hardLimits.maxBudgetUsd). Refusing requested value: $MaxBudgetUsd" }
    foreach ($limitCheck in @(
        @{ name = 'MaxTurns'; value = $MaxTurns; hard = [int]$hardLimits.maxTurns },
        @{ name = 'MaxFilesRead'; value = $MaxFilesRead; hard = [int]$hardLimits.maxFilesRead },
        @{ name = 'MaxCommands'; value = $MaxCommands; hard = [int]$hardLimits.maxCommands },
        @{ name = 'WorkerTimeoutSeconds'; value = $WorkerTimeoutSeconds; hard = [int]$hardLimits.timeoutSeconds }
    )) {
        if ($limitCheck.value -lt 1) { throw "$($limitCheck.name) must be 1 or higher." }
        if ($limitCheck.value -gt $limitCheck.hard) { throw "$($limitCheck.name) must be less than or equal to $($limitCheck.hard). Refusing requested value: $($limitCheck.value)" }
    }
    $BudgetUsd = $MaxBudgetUsd
    $script:ResourceLimits = [ordered]@{
        maxBudgetUsd = $MaxBudgetUsd
        maxTurns = $MaxTurns
        maxFilesRead = $MaxFilesRead
        maxCommands = $MaxCommands
        timeoutSeconds = $WorkerTimeoutSeconds
    }
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

    $workspaceDirectoryNames = @()
    $workspaceRoot = Join-Path $projectRoot 'workspace'
    if (Test-Path -LiteralPath $workspaceRoot -PathType Container) {
        $workspaceDirectoryNames = @(Get-ChildItem -LiteralPath $workspaceRoot -Directory -Force -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { $_.Name })
    }
    $workspaceDirectoryJson = ConvertTo-Json -InputObject @($workspaceDirectoryNames) -Compress

    $finalizationTurn = [Math]::Max(5, [Math]::Floor($MaxTurns * 0.66))
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
- Resource profile is '$ResourceProfile'.
- In plan and review modes, do not modify files.
- In run mode, make only the requested project-local ordinary changes and stop if risky action is needed.

Project-local discovery context:
- Existing immediate subdirectories under workspace/ (JSON names only): $workspaceDirectoryJson
- This Harness-provided list is navigation metadata, not Worker Read evidence. Do not include a directory in "files_read" unless a real Read tool event successfully read a file inside it.
- When a natural-language request omits a path, use these existing names to locate likely project candidates before concluding that the target is missing. Inspect only the most relevant candidate files.

Efficiency limits:
- Keep output concise JSON. Do not quote full file contents.
- Prefer the provided context files before broad searches.
- In plan mode, when a context file named project-context-snapshot.json is provided, successfully Read it before inspecting or proposing project files. It is a Runtime-generated, read-only inventory of the bound project workspace; it does not modify the user project.
- Resource limits: use at most $MaxTurns assistant turns, read at most $MaxFilesRead files, and run at most $MaxCommands shell commands.
- In plan mode, begin with files named by the task, then follow only direct dependencies needed to answer it. Avoid unrelated repository-wide exploration.
- In plan mode, when the task identifies a target directory, list it once and read the relevant files that actually exist. Do not probe guessed README, package, src, or alternate paths unless an observed file directly requires them.
- In plan mode, stop all tool use by turn $finalizationTurn at the latest. Use the remaining turns only to produce the required JSON audit object; never replace it with a Markdown analysis.
- Reserve enough time and budget to produce the required final JSON. If the remaining boundary is insufficient, stop exploring and report the limitation in "risks" or "blocked_on".

Final response audit contract (mandatory in plan, review, and run modes):
- StructuredOutput is the terminal audit submission, not a scratchpad. If that tool is available, call it exactly once, only after every Read/Write/Edit and verification step is finished. Never call it with placeholder, TODO, TBD, guessed, or provisional values, and never call any tool after a successful StructuredOutput submission.
- Your final assistant message must be exactly one valid JSON object and nothing else.
- Do not use a Markdown code fence. Do not add prose, headings, or explanations before or after the JSON object.
- Report only actions that actually occurred. Do not claim a file read, command, change, or check unless you performed it.
- "files_read" must list only files backed by successful Read-compatible tool results, including the Project Context Snapshot when it was successfully read. A failed Read, missing file, directory Read error, or denied tool call must never appear in "files_read".
- Never claim guessed README, package.json, src, or other conventional paths as read. If neither the Project Context Snapshot nor successful discovery/read evidence can confirm project state, explain the evidence gap in "blocked_on" instead of guessing.

Mode-specific audit rules:
- plan: this mode analyzes the project and proposes an execution plan; it does not report completed implementation work.
- plan: require "summary", "files_read", "proposed_changes", "risks", and "blocked_on". "proposed_changes" must be a non-empty array describing concrete future edits.
- plan: the normal human approval that follows a completed plan is a Workflow transition, not a Worker blocker. Do not put "awaiting approval" or equivalent text in "blocked_on"; normally return an empty array. Use "blocked_on" only when missing information or an external dependency prevents you from completing the plan itself.
- plan: do not modify files. "changes_made" and "commands_run" are optional, but if present they must be empty arrays. "tests_or_checks" is optional and is not required for success.
- review: act as a focused change verifier, not a general repository exploration agent. The task prompt should provide the original request, plan result, run result, changes_made, and modified-file list.
- review: treat the original request as the acceptance criteria and the reported modified files as the primary review scope. Read every reported modified file first. Follow only direct imports or dependencies when they are necessary to validate the change.
- review: verify requirement fit, whether the reported files are appropriate, obvious regressions to existing behavior, and concrete risks. Do not scan the whole repository, inspect unrelated history, search another workspace, or use Git/Bash commands.
- review: if the task prompt does not identify the modified files or lacks enough plan/run context to verify the change, record the missing evidence in "blocked_on" instead of expanding the search scope.
- review: stop after collecting bounded evidence for those checks and reserve time to emit the final JSON. Do not modify files; require the seven execution-audit fields, "changes_made" must be an empty array, and accurately report files read. "commands_run" must be an empty array because shell commands are not allowed.
- run: set "run_result" to an object with "type" equal to "modified" or "noop". For "noop", also provide a specific non-empty "reason" explaining why no modification was necessary.
- run: once any Write, Edit, or MultiEdit succeeds, the result is permanently "modified" for this Attempt. Later failures, incomplete work, or missing capabilities must never change it to "noop"; report the observed partial changes and blockers truthfully.
- run: before the first modification, check the tools actually available to you. If the approved task requires creating a file but Write is unavailable, or otherwise cannot be completed with the available tools, do not leave a partial implementation; report the capability gap in "blocked_on".
- run modified: "changes_made" must accurately list every modified file and must not be empty; "commands_run" must accurately list every executed command. Use an empty command array only when no command was executed.
- run modified: Write, Edit, and MultiEdit results or returned file content are not verification evidence and do not count as reading a file.
- run modified: after completing all writes and edits, use the Read tool once more on every file listed in "changes_made". Each final verification read must succeed and produce real Read "tool_use" and "tool_result" events before the final JSON is returned.
- run modified: include those successful final Read targets in "files_read"; do not claim verification from content returned by Write or Edit.
- run noop: "changes_made" must be an empty array, no Write/Edit/MultiEdit may occur, and the stated existing state must be inspected with at least one successful real Read event.
- run noop: "tests_or_checks" must describe the check that proved no modification was needed, and "run_result.reason" must state the concrete reason.

Required final JSON shapes (use the one for the current mode, replace values, and output without backticks):
- plan: {"summary":"...","files_read":[],"proposed_changes":[],"risks":[],"blocked_on":[]}
- review: {"summary":"...","files_read":[],"changes_made":[],"commands_run":[],"tests_or_checks":[],"risks":[],"blocked_on":[]}
- run: {"summary":"...","files_read":[],"changes_made":[],"commands_run":[],"tests_or_checks":[],"risks":[],"blocked_on":[],"run_result":{"type":"modified"}}
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
        resourceProfile = $ResourceProfile; resourceLimits = $script:ResourceLimits
        model = if ($Model) { $Model } else { '<claude-default>' }; bare = [bool]$effectiveBare; dryRun = [bool]$DryRun; mockWorker = [bool]$MockWorker
        workerTimeoutSeconds = $WorkerTimeoutSeconds
        approvedBy = Protect-Text $ApprovedBy; approvalReason = Protect-Text $ApprovalReason
        externalAllowDirs = $resolvedAllowDirs; contextFiles = $resolvedContextFiles; maxTurns = $MaxTurns; maxFilesRead = $MaxFilesRead; maxCommands = $MaxCommands
        allowNetwork = [bool]$AllowNetwork; allowDependencyInstall = [bool]$AllowDependencyInstall; allowGitWrite = [bool]$AllowGitWrite; allowRecursiveDelete = [bool]$AllowRecursiveDelete
    }
    $systemPromptPath = Join-Path $runDir 'system-prompt.txt'
    Save-Json -Value $meta -Path (Join-Path $runDir 'meta.json') -Depth 10
    Write-Utf8Text -Path (Join-Path $runDir 'prompt.txt') -Text $prompt
    Write-Utf8Text -Path $systemPromptPath -Text (Protect-Text $systemPrompt)

    if ($violations.Count -gt 0) {
        $normalized = New-NormalizedResult -Status 'policy_blocked' -Mode $Mode -Summary 'Worker run blocked by local policy before invoking Claude.' -BlockedOn $violations -Artifacts @{ run_dir = $runDir }
        Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status 'policy_blocked' -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
    }

    $arrayProperty = [ordered]@{ type = 'array'; items = [ordered]@{} }
    $auditProperties = [ordered]@{
        summary = [ordered]@{ type = 'string'; minLength = 1; pattern = '^(?!\s*(?:placeholder|todo|tbd)\s*$).+' }
        files_read = $arrayProperty
        proposed_changes = [ordered]@{ type = 'array'; items = [ordered]@{}; minItems = if ($Mode -eq 'plan') { 1 } else { 0 } }
        changes_made = $arrayProperty
        commands_run = $arrayProperty
        tests_or_checks = $arrayProperty
        risks = $arrayProperty
        blocked_on = $arrayProperty
        run_result = [ordered]@{
            type = 'object'
            properties = [ordered]@{ type = [ordered]@{ type = 'string'; enum = @('modified', 'noop') }; reason = [ordered]@{ type = 'string' } }
            required = @('type')
            additionalProperties = $true
        }
    }
    $auditRequired = switch ($Mode) {
        'plan' { @('summary', 'files_read', 'proposed_changes', 'risks', 'blocked_on') }
        'review' { @('summary', 'files_read', 'changes_made', 'commands_run', 'tests_or_checks', 'risks', 'blocked_on') }
        'run' { @('summary', 'files_read', 'changes_made', 'commands_run', 'tests_or_checks', 'risks', 'blocked_on', 'run_result') }
    }
    $auditJsonSchemaObject = [ordered]@{ type = 'object'; properties = $auditProperties; required = $auditRequired; additionalProperties = $false }
    if ($Mode -eq 'run') {
        $auditJsonSchemaObject['allOf'] = @(
            [ordered]@{
                if = [ordered]@{ properties = [ordered]@{ run_result = [ordered]@{ properties = [ordered]@{ type = [ordered]@{ const = 'modified' } } } } }
                then = [ordered]@{ properties = [ordered]@{
                    files_read = [ordered]@{ minItems = 1 }
                    changes_made = [ordered]@{ minItems = 1 }
                    tests_or_checks = [ordered]@{ minItems = 1 }
                } }
            },
            [ordered]@{
                if = [ordered]@{ properties = [ordered]@{ run_result = [ordered]@{ properties = [ordered]@{ type = [ordered]@{ const = 'noop' } } } } }
                then = [ordered]@{ properties = [ordered]@{
                    files_read = [ordered]@{ minItems = 1 }
                    changes_made = [ordered]@{ maxItems = 0 }
                    tests_or_checks = [ordered]@{ minItems = 1 }
                    run_result = [ordered]@{ required = @('type', 'reason'); properties = [ordered]@{ reason = [ordered]@{ type = 'string'; minLength = 1 } } }
                } }
            }
        )
    }
    $auditJsonSchema = $auditJsonSchemaObject | ConvertTo-Json -Depth 14 -Compress
    $auditJsonSchemaCli = $auditJsonSchema -replace '"', '\"'

    $claudeArgs = @()
    if ($effectiveBare) { $claudeArgs += '--bare' }
    $claudeArgs += @('-p', '--permission-mode', [string]$modePolicy.permissionMode, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', ([string]$BudgetUsd), '--system-prompt-file', $systemPromptPath, '--json-schema', $auditJsonSchemaCli)
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
            proposed_changes = if ($Mode -eq 'plan') { @('Mock worker proposed no project-local implementation details.') } else { @() }
            changes_made = @()
            commands_run = @()
            tests_or_checks = @("mock worker path exercised")
            risks = @()
            blocked_on = $mockBlockedOn
            run_result = if ($Mode -eq 'run') { [ordered]@{ type = 'noop'; reason = 'Mock worker did not request a project modification.' } } else { $null }
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
            $normalized = New-NormalizedResult -Status 'worker_failed' -Mode $Mode -Summary 'Claude worker timed out before returning a result.' -BlockedOn @('timeout') -SupervisorNotes @('No structured worker result was returned before timeout. Check the Claude Code provider, authentication, model mapping, and non-interactive execution path.') -ArtifactStatus 'worker_failed_no_artifact_claim' -Artifacts @{ run_dir = $runDir; raw_output = $stdoutPath; raw_error = $stderrPath } -ErrorObject @{ code = 'timeout'; message = "Claude worker timed out after $WorkerTimeoutSeconds seconds." }
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
    $proposedChanges = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'proposed_changes'))
    $changesMade = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'changes_made'))
    $commandsRun = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'commands_run'))
    $testsOrChecks = @(ConvertTo-Array (Get-PropValue -Object $workerResult -Name 'tests_or_checks'))
    $runResult = Get-PropValue -Object $workerResult -Name 'run_result'
    $runResultType = ([string](Get-PropValue -Object $runResult -Name 'type')).Trim().ToLowerInvariant()
    $runResultReason = ([string](Get-PropValue -Object $runResult -Name 'reason')).Trim()
    $toolAudit = Get-ToolAudit -Events $streamEvents
    Save-Json -Value $toolAudit -Path $toolEventsPath -Depth 20
    $capabilityDiagnostics = Get-CapabilityDiagnostics -Events $streamEvents -AllowedTools @($modePolicy.allowedTools)
    $capabilityDiagnosticsPath = Join-Path $runDir 'capability-diagnostics.json'
    Save-Json -Value $capabilityDiagnostics -Path $capabilityDiagnosticsPath -Depth 10
    $successfulCalls = @($toolAudit.tool_calls | Where-Object { $_.succeeded -eq $true -and $_.denied -ne $true })
    $successfulTools = @($successfulCalls | ForEach-Object { $_.tool } | Select-Object -Unique)
    $successfulCommands = @($successfulCalls | Where-Object { $_.tool -match '^(Bash|Shell)$' } | ForEach-Object { [string](Get-PropValue -Object $_.input -Name 'command') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $successfulReadCalls = @($successfulCalls | Where-Object { $_.tool -match '^(Read|Glob|Grep|LS)$' })
    $successfulWriteCalls = @($successfulCalls | Where-Object { $_.tool -match '^(Write|Edit|MultiEdit)$' })
    $observedTurns = @($streamEvents | Where-Object { (Get-PropValue -Object $_ -Name 'type') -eq 'assistant' }).Count
    $resourceUsage = [ordered]@{
        turns = $observedTurns
        toolCalls = $successfulCalls.Count
        filesRead = $successfulReadCalls.Count
        commands = $successfulCommands.Count
        costUsd = $cost
    }
    $auditIssues = @()
    $successfulStructuredOutputCalls = @($successfulCalls | Where-Object { $_.tool -eq 'StructuredOutput' })
    if ($successfulStructuredOutputCalls.Count -gt 0) {
        $firstStructuredOutputIndex = [int]$successfulStructuredOutputCalls[0].call_index
        $laterSuccessfulCalls = @($successfulCalls | Where-Object { $_.call_index -gt $firstStructuredOutputIndex })
        if ($laterSuccessfulCalls.Count -gt 0) {
            $auditIssues += 'premature_audit_output:tool_call_after_structured_output'
        }
    }
    $requiredFields = if ($Mode -eq 'plan') {
        @('summary', 'files_read', 'proposed_changes', 'risks', 'blocked_on')
    } else {
        @('summary', 'files_read', 'changes_made', 'commands_run', 'tests_or_checks', 'risks', 'blocked_on')
    }
    foreach ($requiredField in $requiredFields) {
        if (-not (Test-PropExists -Object $workerResult -Name $requiredField)) {
            $auditIssues += "missing_required_field:$requiredField"
        }
    }
    if (($Mode -eq 'run') -and -not (Test-PropExists -Object $workerResult -Name 'run_result')) {
        $auditIssues += 'missing_required_field:run_result'
    }
    if ($recoveredWorkerOutput) {
        $auditIssues += 'non_strict_output_recovered'
    }
    if ($observedTurns -gt $MaxTurns) { $auditIssues += "resource_limit_exceeded:maxTurns:$observedTurns>$MaxTurns" }
    if ($successfulReadCalls.Count -gt $MaxFilesRead) { $auditIssues += "resource_limit_exceeded:maxFilesRead:$($successfulReadCalls.Count)>$MaxFilesRead" }
    if ($successfulCommands.Count -gt $MaxCommands) { $auditIssues += "resource_limit_exceeded:maxCommands:$($successfulCommands.Count)>$MaxCommands" }
    if (-not $MockWorker) {
        if (($Mode -eq 'plan') -and (($filesRead.Count -eq 0) -or ($successfulReadCalls.Count -eq 0))) {
            $auditIssues += 'missing_read_evidence'
        }
        if (($Mode -eq 'plan') -and ($proposedChanges.Count -eq 0)) {
            $auditIssues += 'missing_proposed_changes'
        }
        if (($Mode -eq 'plan') -and ($changesMade.Count -gt 0)) {
            $auditIssues += 'plan_contract_violation:changes_made_must_be_empty'
        }
        if (($Mode -eq 'review') -and (($filesRead.Count + $commandsRun.Count + $testsOrChecks.Count) -eq 0)) {
            $auditIssues += 'missing_read_or_check_evidence'
        }
        if (($Mode -eq 'run') -and ($testsOrChecks.Count -eq 0)) {
            $auditIssues += 'missing_test_or_check_evidence'
        }
        if ($Mode -eq 'run') {
            if ($runResultType -notin @('modified', 'noop')) {
                $auditIssues += 'invalid_run_result:type_must_be_modified_or_noop'
            } elseif ($runResultType -eq 'modified') {
                if ($changesMade.Count -eq 0) { $auditIssues += 'missing_change_evidence' }
                foreach ($changedFile in $changesMade) {
                    $reportedChange = ConvertTo-AuditPath $changedFile
                    $verifiedChange = $false
                    foreach ($call in $successfulReadCalls) {
                        foreach ($field in @('file_path', 'path')) {
                            $target = ConvertTo-AuditPath (Get-PropValue -Object $call.input -Name $field)
                            if ($target -and ($target -eq $reportedChange -or $target.EndsWith('/' + $reportedChange) -or $reportedChange.EndsWith('/' + $target))) { $verifiedChange = $true }
                        }
                    }
                    if (-not $verifiedChange) { $auditIssues += 'file_audit_mismatch:modified_file_not_verified_by_read'; break }
                }
            } elseif ($runResultType -eq 'noop') {
                if ($changesMade.Count -gt 0) { $auditIssues += 'noop_contract_violation:changes_made_must_be_empty' }
                if ($successfulWriteCalls.Count -gt 0) { $auditIssues += 'noop_contract_violation:write_event_observed' }
                if ($successfulReadCalls.Count -eq 0) { $auditIssues += 'noop_contract_violation:missing_read_evidence' }
                if ([string]::IsNullOrWhiteSpace($runResultReason)) { $auditIssues += 'noop_contract_violation:missing_reason' }
            }
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
            $reported = ConvertTo-AuditPath $reportedFile
            $matched = $false
            foreach ($call in $successfulReadCalls) {
                foreach ($field in @('file_path', 'path')) {
                    $target = ConvertTo-AuditPath (Get-PropValue -Object $call.input -Name $field)
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
    $upstreamWorkerFailed = ($claudeExitCode -ne 0) -or ($isError -eq $true) -or ([string]$isError -eq 'true') -or ([string]$subtype -like 'error_*')
    $errorMessage = if ($claudeErrors.Count -gt 0) {
        [string]$claudeErrors[0]
    } elseif ($stderrText) {
        $stderrText
    } elseif ($upstreamWorkerFailed -and $summaryValue) {
        [string]$summaryValue
    } elseif ($subtype -and ([string]$subtype -ne 'success')) {
        [string]$subtype
    } else {
        'Claude worker failed.'
    }
    $err = if ($subtype -eq 'error_max_budget_usd') {
        $summary = 'Claude worker exceeded the hard budget limit before returning the required audit result.'
        if ($blockedOn -notcontains 'budget_exceeded') { $blockedOn += 'budget_exceeded' }
        @{ code = 'budget_exceeded'; message = $errorMessage }
    } elseif ($parseError) {
        $summary = 'Claude worker returned invalid JSON.'
        @{ code = 'invalid_json'; message = $parseError }
    } elseif ($upstreamWorkerFailed) {
        $summary = 'Claude worker terminated before completing the task.'
        @{ code = 'worker_crash'; message = $errorMessage }
    } elseif ($auditIssues -contains 'premature_audit_output:tool_call_after_structured_output') {
        @{ code = 'premature_audit_output'; message = ($auditIssues -join ', ') }
    } elseif ($auditIssues.Count -gt 0) {
        @{ code = 'audit_validation_failed'; message = ($auditIssues -join ', ') }
    } elseif ($status -ne 'success') {
        $blockedMessage = if ($blockedOn.Count -gt 0) { $blockedOn -join '; ' } else { $errorMessage }
        @{ code = 'worker_blocked'; message = $blockedMessage }
    } else { $null }
    $supervisorNotes = @()
    if ($capabilityDiagnostics.mismatch) {
        $missingToolText = @($capabilityDiagnostics.missingAllowedTools) -join ', '
        $supervisorNotes += "Claude CLI capability mismatch: policy allowed tools were not exposed by the initialized Worker: $missingToolText."
    }
    $artifactStatus = if ($status -eq 'success') { 'worker_reported_success' } else { 'worker_failed_no_artifact_claim' }
    if ($auditIssues.Count -gt 0) {
        $artifactStatus = 'worker_output_needs_review'
        $supervisorNotes += "Worker output did not meet the audit contract: $($auditIssues -join ', ')."
    }
    if ($status -ne 'success' -and (($filesRead.Count -gt 0) -or ($changesMade.Count -gt 0) -or ($testsOrChecks.Count -gt 0) -or ($successfulWriteCalls.Count -gt 0))) {
        $artifactStatus = 'unvalidated_partial_artifacts_possible'
        $supervisorNotes += 'Worker failed but reported files, changes, or checks. Treat artifacts as untrusted partial output until Codex validates them independently.'
        if ($risksFromWorker -notcontains 'Partial artifacts may exist despite worker failure.') {
            $risksFromWorker += 'Partial artifacts may exist despite worker failure.'
        }
    }

    $normalized = New-NormalizedResult -Status $status -Mode $Mode -Summary $summary `
        -FilesRead $filesRead `
        -ProposedChanges $proposedChanges `
        -ChangesMade $changesMade `
        -CommandsRun $commandsRun `
        -TestsOrChecks $testsOrChecks `
        -Risks $risksFromWorker `
        -BlockedOn $blockedOn `
        -RunResult $runResult `
        -ObservedTools @($toolAudit.observed_tools) `
        -ObservedCommands @($toolAudit.observed_commands) `
        -PermissionDenials @($toolAudit.permission_denials) `
        -ObservedFileTargets $toolAudit.file_targets `
        -AuditIssues $auditIssues `
        -SupervisorNotes $supervisorNotes `
        -CapabilityDiagnostics $capabilityDiagnostics `
        -ArtifactStatus $artifactStatus `
        -Cost $cost -ResourceUsage $resourceUsage -Artifacts @{ run_dir = $runDir; raw_output = $stdoutPath; raw_events = $eventStreamPath; raw_error = $stderrPath; tool_events = $toolEventsPath; capability_diagnostics = $capabilityDiagnosticsPath; project_context_snapshot = $projectContextSnapshotPath } -ErrorObject $err
    Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status $status -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath -ClaudeExitCode $claudeExitCode
} catch {
    $message = $_.Exception.Message
    $status = if ($message -match 'TaskFile must be|InputJson must be|Provide either|ContextFiles must be|WorkerTimeoutSeconds|MaxTurns|MaxFilesRead|MaxCommands|MaxBudgetUsd|resource profile|Resource limit|Cannot bind|Mode') { 'invalid_input' } else { 'environment_failed' }
    Write-Utf8Text -Path $stderrPath -Text $message
    $normalized = New-NormalizedResult -Status $status -Mode $Mode -Summary $message -ErrorObject @{ code = $status; message = $message } -Artifacts @{ run_dir = $runDir }
    Complete-Run -RunDir $runDir -RunId $runId -Mode $Mode -ProjectRoot $projectRoot -ExitCodes $ExitCodes -Status $status -Normalized $normalized -RawOutputPath $stdoutPath -ErrorPath $stderrPath
}

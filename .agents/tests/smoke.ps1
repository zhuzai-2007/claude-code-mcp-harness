[CmdletBinding()]
param([switch] $Json)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'claude-task.ps1'
$ledgerScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'ledger.ps1'
$results = New-Object System.Collections.Generic.List[object]
$runIdCounter = 0
function Add-Result { param([string]$Name, [bool]$Passed, [string]$Detail) $script:results.Add([ordered]@{ name = $Name; passed = $Passed; detail = $Detail }) }
function New-TestRunId {
    $script:runIdCounter++
    return (Get-Date).AddMilliseconds($script:runIdCounter).ToString('yyyyMMdd-HHmmss-fff')
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'smoke dry run' -DryRun *> $null
Add-Result 'dry-run' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"

$mockRunId = New-TestRunId
& powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'smoke mock worker' -MockWorker -RunId $mockRunId *> $null
Add-Result 'mock-worker' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"

try {
    $previousMockBlockedOn = $env:CLAUDE_TASK_MOCK_BLOCKED_ON
    $env:CLAUDE_TASK_MOCK_BLOCKED_ON = 'approval required for test'
    $blockedRunId = New-TestRunId
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'smoke blocked worker' -MockWorker -RunId $blockedRunId *> $null
    $blockedExit = $LASTEXITCODE
} finally {
    $env:CLAUDE_TASK_MOCK_BLOCKED_ON = $previousMockBlockedOn
}
$blockedSummaryJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $blockedRunId -Json 2>&1 | Out-String
$blockedStatus = $null
$blockedCount = 0
try {
    $blockedSummary = $blockedSummaryJson | ConvertFrom-Json
    $blockedStatus = $blockedSummary.status
    $blockedCount = @($blockedSummary.blocked_on).Count
} catch {}
Add-Result 'blocked-on-is-not-success' (($blockedExit -eq 1) -and ($blockedStatus -eq 'worker_failed') -and ($blockedCount -eq 1)) "exit=$blockedExit status=$blockedStatus blocked_on=$blockedCount"

try {
    $previousMockNonStrict = $env:CLAUDE_TASK_MOCK_NON_STRICT
    $env:CLAUDE_TASK_MOCK_NON_STRICT = '1'
    $nonStrictRunId = New-TestRunId
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'smoke non-strict worker output' -MockWorker -RunId $nonStrictRunId *> $null
    $nonStrictExit = $LASTEXITCODE
} finally {
    $env:CLAUDE_TASK_MOCK_NON_STRICT = $previousMockNonStrict
}
$nonStrictJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $nonStrictRunId -Json 2>&1 | Out-String
$nonStrictStatus = $null
$nonStrictErrorCode = $null
try {
    $nonStrict = $nonStrictJson | ConvertFrom-Json
    $nonStrictStatus = $nonStrict.status
    $nonStrictErrorCode = $nonStrict.error.code
} catch {}
Add-Result 'non-strict-recovery-needs-review' (($nonStrictExit -eq 1) -and ($nonStrictStatus -eq 'worker_failed') -and ($nonStrictErrorCode -eq 'invalid_json')) "exit=$nonStrictExit status=$nonStrictStatus error=$nonStrictErrorCode"

$fixtureDir = Join-Path $PSScriptRoot 'fixtures'
$expectedUnicodeSummary = '编码检查：“中文”—OK'
try {
    $previousPath = $env:PATH
    $env:PATH = $fixtureDir + [System.IO.Path]::PathSeparator + $previousPath
    $unicodeRunId = New-TestRunId
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'read README and return the fixture result' -NoBare -RunId $unicodeRunId *> $null
    $unicodeExit = $LASTEXITCODE
} finally {
    $env:PATH = $previousPath
}
$unicodeJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $unicodeRunId -Json 2>&1 | Out-String
$unicodeSummary = $null
try {
    $unicodeResult = $unicodeJson | ConvertFrom-Json
    $unicodeSummary = $unicodeResult.summary
} catch {}
Add-Result 'native-stdout-utf8-roundtrip' (($unicodeExit -eq 0) -and ($unicodeSummary -ceq $expectedUnicodeSummary)) "exit=$unicodeExit exact=$($unicodeSummary -ceq $expectedUnicodeSummary)"

$noBomOk = $false
try {
    $unicodeRunDir = Split-Path -Parent ([string]$unicodeResult.artifacts.raw_output)
    $utf8Artifacts = @(
        (Join-Path $unicodeRunDir 'worker-result.normalized.json'),
        (Join-Path $unicodeRunDir 'claude-output.json'),
        (Join-Path $unicodeRunDir 'claude-events.jsonl'),
        (Join-Path $unicodeRunDir 'tool-events.json'),
        (Join-Path $unicodeRunDir 'prompt.txt'),
        (Join-Path $unicodeRunDir 'system-prompt.txt')
    )
    $noBomOk = -not ($utf8Artifacts | Where-Object {
        $bytes = [System.IO.File]::ReadAllBytes($_)
        ($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)
    })
} catch { $noBomOk = $false }
Add-Result 'utf8-artifacts-have-no-bom' $noBomOk "checked normalized output, raw output, tool events, prompt, and system prompt"

function Invoke-FixtureScenario {
    param([string] $Scenario, [string] $Task, [string] $ResourceProfile, [ValidateSet('plan', 'review', 'run')][string] $Mode = 'plan')
    try {
        $previousPath = $env:PATH
        $previousScenario = $env:CLAUDE_TASK_FIXTURE_SCENARIO
        $env:PATH = $fixtureDir + [System.IO.Path]::PathSeparator + $previousPath
        $env:CLAUDE_TASK_FIXTURE_SCENARIO = $Scenario
        $fixtureRunId = New-TestRunId
        $fixtureArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, $Mode, '-Task', $Task, '-NoBare', '-RunId', $fixtureRunId)
        if ($ResourceProfile) { $fixtureArguments += @('-ResourceProfile', $ResourceProfile) }
        if ($Mode -eq 'run') { $fixtureArguments += @('-ApprovedBy', 'smoke-test', '-ApprovalReason', 'Verify final Read evidence after an approved write.') }
        & powershell @fixtureArguments *> $null
        $fixtureExit = $LASTEXITCODE
    } finally {
        $env:PATH = $previousPath
        $env:CLAUDE_TASK_FIXTURE_SCENARIO = $previousScenario
    }
    $fixtureJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $fixtureRunId -Json 2>&1 | Out-String
    return [pscustomobject]@{ exitCode = $fixtureExit; result = ($fixtureJson | ConvertFrom-Json); runId = $fixtureRunId }
}

function Get-GeneratedSystemPrompt {
    param([ValidateSet('plan', 'review', 'run')][string] $Mode)
    $promptRunId = New-TestRunId
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, $Mode, '-Task', "verify $Mode response contract", '-DryRun', '-RunId', $promptRunId)
    if ($Mode -eq 'run') { $arguments += @('-ApprovedBy', 'smoke-test', '-ApprovalReason', 'Inspect generated run response contract.') }
    & powershell @arguments *> $null
    if ($LASTEXITCODE -ne 0) { return $null }
    $promptResultJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $promptRunId -Json 2>&1 | Out-String
    $promptResult = $promptResultJson | ConvertFrom-Json
    return Get-Content -LiteralPath (Join-Path $promptResult.artifacts.run_dir 'system-prompt.txt') -Raw -Encoding UTF8
}

foreach ($contractMode in @('plan', 'review', 'run')) {
    $generatedPrompt = Get-GeneratedSystemPrompt -Mode $contractMode
    $missingContractFields = @(@('files_read', 'changes_made', 'commands_run', 'tests_or_checks', 'risks', 'blocked_on') | Where-Object { $generatedPrompt -notmatch [regex]::Escape($_) })
    $hasCommonContract = $generatedPrompt -and
        ($generatedPrompt -match 'exactly one valid JSON object and nothing else') -and
        ($generatedPrompt -match 'Do not use a Markdown code fence') -and
        ($generatedPrompt -match '"summary":"\.\.\."') -and
        ($missingContractFields.Count -eq 0)
    $hasModeContract = switch ($contractMode) {
        'plan' { ($generatedPrompt -match 'plan: this mode analyzes the project and proposes an execution plan') -and ($generatedPrompt -match 'summary.*files_read.*proposed_changes.*risks.*blocked_on') -and ($generatedPrompt -match 'tests_or_checks.*optional') -and ($generatedPrompt -match 'follow only direct dependencies') -and ($generatedPrompt -match 'Reserve enough time and budget') -and ($generatedPrompt -match 'normal human approval.*Workflow transition, not a Worker blocker') -and ($generatedPrompt -match 'Existing immediate subdirectories under workspace') -and ($generatedPrompt -match 'navigation metadata, not Worker Read evidence') }
        'review' { ($generatedPrompt -match 'focused change verifier') -and ($generatedPrompt -match 'Read every reported modified file first') -and ($generatedPrompt -match 'Do not scan the whole repository') -and ($generatedPrompt -match 'changes_made.*must be an empty array') -and ($generatedPrompt -match 'commands_run.*must be an empty array') }
        'run' { ($generatedPrompt -match 'run_result.*modified.*noop') -and ($generatedPrompt -match 'run modified:.*changes_made.*must not be empty') -and ($generatedPrompt -match 'Write, Edit, and MultiEdit results.*are not verification evidence') -and ($generatedPrompt -match 'Read tool once more on every file listed') -and ($generatedPrompt -match 'run noop:.*changes_made.*empty array') -and ($generatedPrompt -match 'run_result.reason.*concrete reason') }
    }
    Add-Result "prompt-contract-$contractMode" ($hasCommonContract -and $hasModeContract) "common=$hasCommonContract mode=$hasModeContract"
}

$schemaRunId = New-TestRunId
& powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'verify CLI structured output enforcement' -DryRun -RunId $schemaRunId *> $null
$schemaCommandPath = Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.agent-runs') "$schemaRunId\command.txt"
$schemaCommand = if (Test-Path -LiteralPath $schemaCommandPath) { Get-Content -LiteralPath $schemaCommandPath -Raw } else { '' }
Add-Result 'cli-json-schema-enforced' (($schemaCommand -match '--json-schema') -and ($schemaCommand -match 'proposed_changes')) "schemaFlag=$($schemaCommand -match '--json-schema')"
Add-Result 'system-prompt-uses-file-on-windows' (($schemaCommand -match '--system-prompt-file') -and ($schemaCommand -notmatch '--system-prompt\s+"You are Claude Code')) "fileFlag=$($schemaCommand -match '--system-prompt-file')"

$missingField = Invoke-FixtureScenario -Scenario 'missing-required-field' -Task 'return an audit result that omits one required field'
Add-Result 'missing-required-field-is-rejected' (($missingField.exitCode -eq 1) -and ($missingField.result.status -eq 'worker_failed') -and ($missingField.result.error.code -eq 'audit_validation_failed') -and ($missingField.result.error.message -match 'missing_required_field:risks')) "exit=$($missingField.exitCode) error=$($missingField.result.error.message)"

$completeAudit = Invoke-FixtureScenario -Scenario 'complete-audit-json' -Task 'read README and return the complete audit JSON contract'
$completeAuditIssueCount = @($completeAudit.result.audit_issues).Count
Add-Result 'complete-json-audit-contract-passes' (($completeAudit.exitCode -eq 0) -and ($completeAudit.result.status -eq 'success') -and ($completeAuditIssueCount -eq 0) -and ($completeAudit.result.observed_tools -contains 'Read')) "exit=$($completeAudit.exitCode) status=$($completeAudit.result.status) audit_issues=$completeAuditIssueCount"

$dotDirectoryRead = Invoke-FixtureScenario -Scenario 'dot-directory-read' -Task 'read a dot-directory policy file and report its relative path'
Add-Result 'dot-directory-read-path-matches-evidence' (($dotDirectoryRead.exitCode -eq 0) -and ($dotDirectoryRead.result.status -eq 'success') -and (@($dotDirectoryRead.result.audit_issues).Count -eq 0) -and ($dotDirectoryRead.result.files_read -contains '.agents/policy.json')) "exit=$($dotDirectoryRead.exitCode) status=$($dotDirectoryRead.result.status) audit_issues=$(@($dotDirectoryRead.result.audit_issues) -join ',')"

$planWithProposal = Invoke-FixtureScenario -Scenario 'plan-with-proposed-changes' -Task 'inspect the task board and propose search changes'
Add-Result 'plan-read-with-proposed-changes-passes' (($planWithProposal.exitCode -eq 0) -and ($planWithProposal.result.status -eq 'success') -and (@($planWithProposal.result.proposed_changes).Count -gt 0) -and (@($planWithProposal.result.changes_made).Count -eq 0) -and ($planWithProposal.result.observed_tools -contains 'Read')) "exit=$($planWithProposal.exitCode) status=$($planWithProposal.result.status) proposals=$(@($planWithProposal.result.proposed_changes).Count)"

$planApprovalBlocker = Invoke-FixtureScenario -Scenario 'plan-approval-as-blocker' -Task 'misreport the normal approval transition as a blocker'
Add-Result 'plan-approval-blocker-still-fails' (($planApprovalBlocker.exitCode -eq 1) -and ($planApprovalBlocker.result.error.code -eq 'worker_blocked') -and ($planApprovalBlocker.result.error.message -match 'Awaiting human approval')) "exit=$($planApprovalBlocker.exitCode) error=$($planApprovalBlocker.result.error.message)"

$planMissingFields = Invoke-FixtureScenario -Scenario 'plan-missing-summary-files-read' -Task 'return an invalid plan without summary or files_read'
Add-Result 'plan-missing-summary-files-read-fails' (($planMissingFields.exitCode -eq 1) -and ($planMissingFields.result.status -eq 'worker_failed') -and ($planMissingFields.result.error.code -eq 'audit_validation_failed') -and ($planMissingFields.result.error.message -match 'missing_required_field:summary') -and ($planMissingFields.result.error.message -match 'missing_required_field:files_read')) "exit=$($planMissingFields.exitCode) error=$($planMissingFields.result.error.message)"

$focusedReview = Invoke-FixtureScenario -Scenario 'focused-review' -Task 'Original request: update the board. Plan result: bounded edit. Run result: modified. changes_made: README.md. Modified files: README.md.' -ResourceProfile 'review_readonly' -Mode 'review'
Add-Result 'focused-review-read-evidence-passes' (($focusedReview.exitCode -eq 0) -and ($focusedReview.result.status -eq 'success') -and ($focusedReview.result.resource_profile -eq 'review_readonly') -and ($focusedReview.result.resource_limits.maxTurns -eq 50) -and ($focusedReview.result.resource_limits.maxFilesRead -eq 40) -and ($focusedReview.result.observed_tools -contains 'Read') -and (@($focusedReview.result.commands_run).Count -eq 0)) "exit=$($focusedReview.exitCode) profile=$($focusedReview.result.resource_profile) tools=$($focusedReview.result.observed_tools -join ',')"

$budgetExceeded = Invoke-FixtureScenario -Scenario 'budget-exceeded' -Task 'inspect the project until the provider hard budget is reached'
$budgetAuditIssues = @($budgetExceeded.result.audit_issues)
Add-Result 'budget-exceeded-is-classified' (($budgetExceeded.exitCode -eq 1) -and ($budgetExceeded.result.status -eq 'worker_failed') -and ($budgetExceeded.result.error.code -eq 'budget_exceeded') -and ($budgetExceeded.result.summary -match 'hard budget') -and ($budgetExceeded.result.blocked_on -contains 'budget_exceeded')) "exit=$($budgetExceeded.exitCode) error=$($budgetExceeded.result.error.code)"
Add-Result 'budget-exceeded-is-not-audit-failure' (($budgetExceeded.result.error.code -ne 'audit_validation_failed') -and ($budgetAuditIssues -contains 'missing_required_field:summary')) "error=$($budgetExceeded.result.error.code) audit_issues=$($budgetAuditIssues -join ',')"

$apiConnectionError = Invoke-FixtureScenario -Scenario 'api-connection-error' -Task 'exercise an upstream API connection failure'
Add-Result 'upstream-error-message-is-preserved' (($apiConnectionError.exitCode -eq 1) -and ($apiConnectionError.result.error.code -eq 'worker_crash') -and ($apiConnectionError.result.error.message -eq 'API Error: Unable to connect to API (ConnectionRefused)')) "exit=$($apiConnectionError.exitCode) error=$($apiConnectionError.result.error.message)"

$smallProfile = Invoke-FixtureScenario -Scenario 'complete-audit-json' -Task 'read one file with the default resource profile' -ResourceProfile 'small_readonly'
Add-Result 'resource-profile-small-readonly-passes' (($smallProfile.exitCode -eq 0) -and ($smallProfile.result.resource_profile -eq 'small_readonly') -and ($smallProfile.result.resource_limits.maxBudgetUsd -eq 1) -and ($smallProfile.result.resource_limits.maxTurns -eq 30) -and ($smallProfile.result.resource_limits.maxFilesRead -eq 30) -and ($smallProfile.result.resource_limits.maxCommands -eq 1)) "exit=$($smallProfile.exitCode) profile=$($smallProfile.result.resource_profile) effectiveBudget=$($smallProfile.result.resource_limits.maxBudgetUsd) turns=$($smallProfile.result.resource_limits.maxTurns) maxFiles=$($smallProfile.result.resource_limits.maxFilesRead) maxCommands=$($smallProfile.result.resource_limits.maxCommands)"

$smallOverRange = Invoke-FixtureScenario -Scenario 'many-reads' -Task 'inspect thirty-five related files' -ResourceProfile 'small_readonly'
Add-Result 'resource-profile-small-readonly-enforces-range' (($smallOverRange.exitCode -eq 1) -and ($smallOverRange.result.error.code -eq 'audit_validation_failed') -and ($smallOverRange.result.error.message -match 'resource_limit_exceeded:maxFilesRead')) "exit=$($smallOverRange.exitCode) error=$($smallOverRange.result.error.message)"

$explorationProfile = Invoke-FixtureScenario -Scenario 'many-reads' -Task 'explore thirty-five related project files' -ResourceProfile 'exploration_readonly'
Add-Result 'resource-profile-exploration-readonly-allows-multifile-discovery' (($explorationProfile.exitCode -eq 0) -and ($explorationProfile.result.resource_profile -eq 'exploration_readonly') -and ($explorationProfile.result.resource_limits.maxBudgetUsd -eq 1.5) -and ($explorationProfile.result.resource_limits.maxTurns -eq 100) -and ($explorationProfile.result.resource_limits.maxFilesRead -eq 100) -and ($explorationProfile.result.resource_limits.maxCommands -eq 1) -and ($explorationProfile.result.resource_usage.filesRead -eq 35)) "exit=$($explorationProfile.exitCode) profile=$($explorationProfile.result.resource_profile) effectiveBudget=$($explorationProfile.result.resource_limits.maxBudgetUsd) used=$($explorationProfile.result.resource_usage.filesRead) max=$($explorationProfile.result.resource_limits.maxFilesRead)"

$mediumProfile = Invoke-FixtureScenario -Scenario 'many-reads' -Task 'inspect thirty-five related files' -ResourceProfile 'medium_analysis'
Add-Result 'resource-profile-medium-analysis-allows-larger-range' (($mediumProfile.exitCode -eq 0) -and ($mediumProfile.result.resource_profile -eq 'medium_analysis') -and ($mediumProfile.result.resource_limits.maxBudgetUsd -eq 2) -and ($mediumProfile.result.resource_limits.maxFilesRead -eq 100) -and ($mediumProfile.result.resource_usage.filesRead -eq 35)) "exit=$($mediumProfile.exitCode) profile=$($mediumProfile.result.resource_profile) budget=$($mediumProfile.result.resource_limits.maxBudgetUsd) used=$($mediumProfile.result.resource_usage.filesRead) max=$($mediumProfile.result.resource_limits.maxFilesRead)"

$hardLimitRunId = New-TestRunId
& powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'must not start above hard budget' -ResourceProfile 'medium_analysis' -MaxBudgetUsd 5.01 -DryRun -RunId $hardLimitRunId *> $null
$hardLimitExit = $LASTEXITCODE
$hardLimitJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $hardLimitRunId -Json 2>&1 | Out-String
$hardLimitResult = $hardLimitJson | ConvertFrom-Json
Add-Result 'resource-profile-hard-limit-rejected' (($hardLimitExit -eq 3) -and ($hardLimitResult.status -eq 'invalid_input') -and ($hardLimitResult.error.message -match 'less than or equal to 5')) "exit=$hardLimitExit status=$($hardLimitResult.status) error=$($hardLimitResult.error.message)"

$longSummary = Invoke-FixtureScenario -Scenario 'long-summary' -Task 'return a long strict JSON summary after inspecting files'
Add-Result 'strict-long-summary-preserved' (($longSummary.exitCode -eq 0) -and ($longSummary.result.summary.Length -gt 300) -and $longSummary.result.summary.EndsWith('丙丁')) "exit=$($longSummary.exitCode) length=$($longSummary.result.summary.Length)"

$unverifiable = Invoke-FixtureScenario -Scenario 'claimed-commands-no-events' -Task 'claim shell checks without tool events'
Add-Result 'claimed-checks-without-events-fail' (($unverifiable.exitCode -eq 1) -and ($unverifiable.result.error.code -eq 'audit_validation_failed') -and ($unverifiable.result.error.message -match 'unverifiable_check_evidence')) "exit=$($unverifiable.exitCode) error=$($unverifiable.result.error.message)"

$lsObserved = Invoke-FixtureScenario -Scenario 'ls-observed' -Task 'check a directory with LS'
Add-Result 'ls-event-validates-check' (($lsObserved.exitCode -eq 0) -and ($lsObserved.result.observed_tools -contains 'LS')) "exit=$($lsObserved.exitCode) observed=$($lsObserved.result.observed_tools -join ',')"

$bashMismatch = Invoke-FixtureScenario -Scenario 'bash-unreported' -Task 'inspect git state'
Add-Result 'observed-bash-must-be-reported' (($bashMismatch.exitCode -eq 1) -and ($bashMismatch.result.error.message -match 'command_audit_mismatch')) "exit=$($bashMismatch.exitCode) error=$($bashMismatch.result.error.message)"

$deniedCheck = Invoke-FixtureScenario -Scenario 'permission-denial' -Task 'read a file and report the check'
Add-Result 'permission-denial-is-not-check-evidence' (($deniedCheck.exitCode -eq 1) -and ($deniedCheck.result.error.message -match 'unverifiable_check_evidence') -and ($deniedCheck.result.permission_denials.Count -eq 1)) "exit=$($deniedCheck.exitCode) denials=$($deniedCheck.result.permission_denials.Count)"

$failedCheck = Invoke-FixtureScenario -Scenario 'failed-tool-result' -Task 'claim a read whose tool result failed'
Add-Result 'failed-tool-result-is-not-check-evidence' (($failedCheck.exitCode -eq 1) -and ($failedCheck.result.error.message -match 'file_audit_mismatch') -and ($failedCheck.result.permission_denials.Count -eq 0)) "exit=$($failedCheck.exitCode) denials=$($failedCheck.result.permission_denials.Count)"

$fileMismatch = Invoke-FixtureScenario -Scenario 'file-read-unreported-by-events' -Task 'claim a file read without an event'
Add-Result 'reported-file-read-must-be-observed' (($fileMismatch.exitCode -eq 1) -and ($fileMismatch.result.error.message -match 'file_audit_mismatch')) "exit=$($fileMismatch.exitCode) error=$($fileMismatch.result.error.message)"

$runWithoutFinalRead = Invoke-FixtureScenario -Scenario 'run-write-without-final-read' -Task 'write the approved fixture file but omit the final Read event' -Mode 'run'
Add-Result 'run-write-without-real-read-still-fails' (($runWithoutFinalRead.exitCode -eq 1) -and ($runWithoutFinalRead.result.status -eq 'worker_failed') -and ($runWithoutFinalRead.result.error.code -eq 'audit_validation_failed') -and ($runWithoutFinalRead.result.error.message -match 'file_audit_mismatch') -and ($runWithoutFinalRead.result.error.message -match 'reported_file_read_not_observed')) "exit=$($runWithoutFinalRead.exitCode) error=$($runWithoutFinalRead.result.error.message)"

$runWithFinalRead = Invoke-FixtureScenario -Scenario 'run-write-with-final-read' -Task 'write the approved fixture file and verify it with a final Read event' -Mode 'run'
Add-Result 'run-write-with-real-read-passes' (($runWithFinalRead.exitCode -eq 0) -and ($runWithFinalRead.result.status -eq 'success') -and (@($runWithFinalRead.result.audit_issues).Count -eq 0) -and ($runWithFinalRead.result.observed_tools -contains 'Write') -and ($runWithFinalRead.result.observed_tools -contains 'Read')) "exit=$($runWithFinalRead.exitCode) status=$($runWithFinalRead.result.status) tools=$($runWithFinalRead.result.observed_tools -join ',')"

$runNoopWithEvidence = Invoke-FixtureScenario -Scenario 'run-noop-with-read-and-reason' -Task 'leave the approved target unchanged when its state is already correct' -Mode 'run'
$runNoopReason = if ($runNoopWithEvidence.result.run_result -and $runNoopWithEvidence.result.run_result.PSObject.Properties['reason']) { [string]$runNoopWithEvidence.result.run_result.reason } else { '' }
Add-Result 'run-noop-with-read-and-reason-passes' (($runNoopWithEvidence.exitCode -eq 0) -and ($runNoopWithEvidence.result.status -eq 'success') -and (@($runNoopWithEvidence.result.audit_issues).Count -eq 0) -and ($runNoopWithEvidence.result.run_result.type -eq 'noop') -and -not [string]::IsNullOrWhiteSpace($runNoopReason) -and ($runNoopWithEvidence.result.observed_tools -contains 'Read')) "exit=$($runNoopWithEvidence.exitCode) status=$($runNoopWithEvidence.result.status) reason=$runNoopReason"

$runNoopWithoutEvidence = Invoke-FixtureScenario -Scenario 'run-noop-without-evidence' -Task 'claim no change is needed without inspecting the target' -Mode 'run'
Add-Result 'run-noop-without-evidence-fails' (($runNoopWithoutEvidence.exitCode -eq 1) -and ($runNoopWithoutEvidence.result.status -eq 'worker_failed') -and ($runNoopWithoutEvidence.result.error.code -eq 'audit_validation_failed') -and ($runNoopWithoutEvidence.result.error.message -match 'missing_test_or_check_evidence') -and ($runNoopWithoutEvidence.result.error.message -match 'noop_contract_violation:missing_read_evidence')) "exit=$($runNoopWithoutEvidence.exitCode) error=$($runNoopWithoutEvidence.result.error.message)"

$runNoopWithoutReason = Invoke-FixtureScenario -Scenario 'run-noop-without-reason' -Task 'claim no change is needed without explaining why' -Mode 'run'
Add-Result 'run-noop-without-reason-fails' (($runNoopWithoutReason.exitCode -eq 1) -and ($runNoopWithoutReason.result.status -eq 'worker_failed') -and ($runNoopWithoutReason.result.error.message -match 'noop_contract_violation:missing_reason')) "exit=$($runNoopWithoutReason.exitCode) error=$($runNoopWithoutReason.result.error.message)"

$runModifiedWithoutChanges = Invoke-FixtureScenario -Scenario 'run-modified-without-changes' -Task 'claim a modified result without reporting any changes' -Mode 'run'
Add-Result 'run-modified-requires-change-evidence' (($runModifiedWithoutChanges.exitCode -eq 1) -and ($runModifiedWithoutChanges.result.error.message -match 'missing_change_evidence')) "exit=$($runModifiedWithoutChanges.exitCode) error=$($runModifiedWithoutChanges.result.error.message)"

$summaryJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $mockRunId -Json 2>&1 | Out-String
$normalizedFieldsOk = $false
try {
    $normalized = $summaryJson | ConvertFrom-Json
    $normalizedFieldsOk = ($null -ne $normalized.PSObject.Properties['artifact_status']) -and ($null -ne $normalized.PSObject.Properties['supervisor_notes'])
} catch {
    $normalizedFieldsOk = $false
}
Add-Result 'normalized-supervisor-fields' $normalizedFieldsOk 'artifact_status and supervisor_notes present'

$ledgerJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $ledgerScript -Tail 1 -Json 2>&1 | Out-String
$ledgerExit = $LASTEXITCODE
$ledgerOk = $false
try {
    $ledger = $ledgerJson | ConvertFrom-Json
    $ledgerOk = ($ledgerExit -eq 0) -and ($ledger.entries.Count -ge 1) -and ($ledger.entries[0].runId)
} catch {
    $ledgerOk = $false
}
Add-Result 'ledger-readable' $ledgerOk "exit=$ledgerExit"

& powershell -NoProfile -ExecutionPolicy Bypass -File $script run -Task 'write a file' -DryRun *> $null
Add-Result 'run-without-approval-blocked' ($LASTEXITCODE -eq 2) "exit=$LASTEXITCODE"

$runDryId = New-TestRunId
& powershell -NoProfile -ExecutionPolicy Bypass -File $script run -Task 'write one file without shell commands' -ApprovedBy 'smoke-test' -ApprovalReason 'Inspect generated CLI restrictions.' -DryRun -RunId $runDryId *> $null
$runDryExit = $LASTEXITCODE
$runDryResult = (& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $runDryId -Json 2>&1 | Out-String) | ConvertFrom-Json
$runDryCommand = Get-Content -LiteralPath $runDryResult.artifacts.command -Raw -Encoding UTF8
Add-Result 'run-bash-is-cli-disallowed' (($runDryExit -eq 0) -and ($runDryCommand -match '--disallowedTools\s+Bash')) "exit=$runDryExit disallowed=$($runDryCommand -match '--disallowedTools\s+Bash')"

& powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'please run git push' -DryRun *> $null
Add-Result 'git-push-blocked' ($LASTEXITCODE -eq 2) "exit=$LASTEXITCODE"

$outside = Join-Path ([System.IO.Path]::GetTempPath()) ('worker-task-' + [guid]::NewGuid().ToString('N') + '.txt')
Set-Content -LiteralPath $outside -Value 'outside task' -Encoding UTF8
& powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -TaskFile $outside -DryRun *> $null
Add-Result 'taskfile-outside-blocked' ($LASTEXITCODE -eq 3) "exit=$LASTEXITCODE"
Remove-Item -LiteralPath $outside -Force

$passed = -not (@($results | Where-Object { -not $_.passed }).Count)
if ($Json) {
    [ordered]@{ passed = $passed; results = $results } | ConvertTo-Json -Depth 6
    if ($passed) { exit 0 } else { exit 1 }
}
foreach ($result in $results) { Write-Host "$($result.name): $($result.passed) ($($result.detail))" }
if ($passed) { exit 0 } else { exit 1 }

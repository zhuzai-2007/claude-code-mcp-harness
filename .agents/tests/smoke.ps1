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
Add-Result 'non-strict-recovery-needs-review' (($nonStrictExit -eq 1) -and ($nonStrictStatus -eq 'worker_failed') -and ($nonStrictErrorCode -eq 'audit_validation_failed')) "exit=$nonStrictExit status=$nonStrictStatus error=$nonStrictErrorCode"

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
    param([string] $Scenario, [string] $Task)
    try {
        $previousPath = $env:PATH
        $previousScenario = $env:CLAUDE_TASK_FIXTURE_SCENARIO
        $env:PATH = $fixtureDir + [System.IO.Path]::PathSeparator + $previousPath
        $env:CLAUDE_TASK_FIXTURE_SCENARIO = $Scenario
        $fixtureRunId = New-TestRunId
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task $Task -NoBare -RunId $fixtureRunId *> $null
        $fixtureExit = $LASTEXITCODE
    } finally {
        $env:PATH = $previousPath
        $env:CLAUDE_TASK_FIXTURE_SCENARIO = $previousScenario
    }
    $fixtureJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $fixtureRunId -Json 2>&1 | Out-String
    return [pscustomobject]@{ exitCode = $fixtureExit; result = ($fixtureJson | ConvertFrom-Json); runId = $fixtureRunId }
}

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

try {
    $previousPath = $env:PATH
    $env:PATH = $fixtureDir + [System.IO.Path]::PathSeparator + $previousPath
    $runAuditRunId = New-TestRunId
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script run -Task 'write the requested fixture output' -ApprovedBy 'smoke-test' -ApprovalReason 'Verify run audit evidence enforcement.' -NoBare -RunId $runAuditRunId *> $null
    $runAuditExit = $LASTEXITCODE
} finally {
    $env:PATH = $previousPath
}
$runAuditJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'summary.ps1') -RunId $runAuditRunId -Json 2>&1 | Out-String
$runAuditError = $null
try { $runAuditError = ($runAuditJson | ConvertFrom-Json).error.message } catch {}
Add-Result 'run-requires-change-evidence' (($runAuditExit -eq 1) -and ($runAuditError -match 'missing_change_evidence')) "exit=$runAuditExit missing_change=$($runAuditError -match 'missing_change_evidence')"

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

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
        (Join-Path $unicodeRunDir 'prompt.txt'),
        (Join-Path $unicodeRunDir 'system-prompt.txt')
    )
    $noBomOk = -not ($utf8Artifacts | Where-Object {
        $bytes = [System.IO.File]::ReadAllBytes($_)
        ($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)
    })
} catch { $noBomOk = $false }
Add-Result 'utf8-artifacts-have-no-bom' $noBomOk "checked normalized output, raw output, prompt, and system prompt"

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

[CmdletBinding()]
param(
    [int] $DefaultTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string] $Path)
    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function New-OutputHead {
    param([AllowNull()][string] $Text)
    if ([string]::IsNullOrEmpty($Text)) { return "" }
    $flat = $Text -replace "`r", "" 
    if ($flat.Length -le 1200) { return $flat }
    return $flat.Substring(0, 1200)
}

function Invoke-DiagnosticCommand {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $Command,
        [Parameter(Mandatory = $true)][string] $Cwd,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][int] $TimeoutSeconds,
        [Parameter(Mandatory = $true)][string] $OutputDir
    )

    $stdoutPath = Join-Path $OutputDir "$Name.stdout.txt"
    $stderrPath = Join-Path $OutputDir "$Name.stderr.txt"
    $started = Get-Date
    $job = Start-Job -ScriptBlock {
        param($Cwd, $Arguments, $StdoutPath, $StderrPath)
        Set-Location -LiteralPath $Cwd
        try {
            & claude @Arguments > $StdoutPath 2> $StderrPath
            return $LASTEXITCODE
        } catch {
            $_ | Out-String | Set-Content -LiteralPath $StderrPath -Encoding UTF8
            return 1
        }
    } -ArgumentList $Cwd, $Arguments, $stdoutPath, $stderrPath

    $completed = Wait-Job -Job $job -Timeout $TimeoutSeconds
    $timedOut = $false
    if (-not $completed) {
        $timedOut = $true
        Stop-Job -Job $job | Out-Null
        Remove-Job -Job $job -Force | Out-Null
        "Timed out after $TimeoutSeconds seconds." | Set-Content -LiteralPath $stderrPath -Encoding UTF8
        $exitCode = $null
    } else {
        $exitCode = Receive-Job -Job $job
        Remove-Job -Job $job -Force | Out-Null
    }
    $duration = [Math]::Round(((Get-Date) - $started).TotalSeconds, 3)
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
    $jsonParseOk = $false
    if (-not [string]::IsNullOrWhiteSpace($stdout)) {
        try { $null = $stdout | ConvertFrom-Json; $jsonParseOk = $true } catch { $jsonParseOk = $false }
    }

    $classification = if ($timedOut) {
        if ($stderr -match '(?i)auth|login|trust|confirm|permission') { 'claude_auth_or_trust_required' } else { 'claude_noninteractive_hangs' }
    } elseif ($exitCode -ne 0) {
        if ($stderr -match '(?i)auth|login|trust') { 'claude_auth_or_trust_required' } elseif ($stderr -match '(?i)permission|confirm|approval') { 'permission_prompt_waiting' } else { 'worker_failed' }
    } elseif ($Name -match 'json|plan|accept|edit' -and -not $jsonParseOk) {
        'output_parsing_issue'
    } else {
        'success'
    }

    return [ordered]@{
        name = $Name
        command = $Command
        cwd = $Cwd
        duration_seconds = $duration
        exit_code = $exitCode
        stdout_head = New-OutputHead $stdout
        stderr_head = New-OutputHead $stderr
        timeout_or_not = $timedOut
        json_parse_ok = $jsonParseOk
        result_classification = $classification
        stdout_path = $stdoutPath
        stderr_path = $stderrPath
    }
}

function Get-RunDirs {
    param([string] $ProjectRoot, [string] $AgentsRoot)
    $roots = @((Join-Path $AgentsRoot "runs"), (Join-Path $ProjectRoot ".agent-runs"))
    $dirs = @()
    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
            $dirs += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
        }
    }
    return @($dirs)
}

$agentsRoot = Resolve-FullPath (Join-Path $PSScriptRoot "..")
$projectRoot = Resolve-FullPath (Join-Path $agentsRoot "..")
$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss-fff")
$reportRoot = Join-Path $projectRoot ".agent-runs"
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportDir = Join-Path $reportRoot "worker-invocation-diagnostics-$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$tests = @(
    @{ name = "01_version"; command = "claude --version"; args = @("--version"); timeout = 30 },
    @{ name = "02_min_text"; command = 'claude -p "Return exactly OK and nothing else."'; args = @("-p", "Return exactly OK and nothing else."); timeout = 30 },
    @{ name = "03_min_json"; command = 'claude -p --output-format json "Return a short JSON result saying OK."'; args = @("-p", "--output-format", "json", "Return a short JSON result saying OK."); timeout = 60 },
    @{ name = "04_plan_json"; command = 'claude -p --permission-mode plan --output-format json "Inspect the current directory name only. Do not modify files."'; args = @("-p", "--permission-mode", "plan", "--output-format", "json", "Inspect the current directory name only. Do not modify files."); timeout = 60 },
    @{ name = "05_accept_no_edit"; command = 'claude -p --permission-mode acceptEdits --output-format json "Return a short JSON summary. Do not modify files."'; args = @("-p", "--permission-mode", "acceptEdits", "--output-format", "json", "Return a short JSON summary. Do not modify files."); timeout = 60 },
    @{ name = "06_min_edit"; command = 'claude -p --permission-mode acceptEdits --output-format json "Only modify workspace/diagnostic-write.txt and outbox/diagnostic-report.md ..."'; args = @("-p", "--permission-mode", "acceptEdits", "--output-format", "json", "Only modify workspace/diagnostic-write.txt and outbox/diagnostic-report.md. Write one line hello from diagnostic claude worker to workspace/diagnostic-write.txt and a very short diagnostic report to outbox/diagnostic-report.md. Do not modify any other files."); timeout = 120 }
)

$results = foreach ($test in $tests) {
    Invoke-DiagnosticCommand -Name $test.name -Command $test.command -Cwd $projectRoot -Arguments $test.args -TimeoutSeconds $test.timeout -OutputDir $reportDir
}

$runBefore = @(Get-RunDirs -ProjectRoot $projectRoot -AgentsRoot $agentsRoot)
$timeoutCommand = '.\.agents\claude-task.ps1 run -Task "timeout regression; do not modify files" -ApprovedBy Codex -ApprovalReason "timeout blocked_on regression" -WorkerTimeoutSeconds 1'
$timeoutStarted = Get-Date
& (Join-Path $agentsRoot "claude-task.ps1") run -Task "timeout regression; do not modify files" -ApprovedBy Codex -ApprovalReason "timeout blocked_on regression" -WorkerTimeoutSeconds 1 > (Join-Path $reportDir "07_timeout_regression.stdout.txt") 2> (Join-Path $reportDir "07_timeout_regression.stderr.txt")
$timeoutExit = $LASTEXITCODE
$runAfter = @(Get-RunDirs -ProjectRoot $projectRoot -AgentsRoot $agentsRoot)
$newRun = @($runAfter | Where-Object { $runBefore -notcontains $_ } | Sort-Object -Descending | Select-Object -First 1)
$timeoutResultPath = if ($newRun.Count -gt 0) { Join-Path $newRun[0] "worker-result.normalized.json" } else { $null }
$timeoutResult = if ($timeoutResultPath -and (Test-Path -LiteralPath $timeoutResultPath)) { Get-Content -LiteralPath $timeoutResultPath -Raw | ConvertFrom-Json } else { $null }
$timeoutBlockedOnOk = $false
if ($timeoutResult -and $timeoutResult.blocked_on) {
    $timeoutBlockedOnOk = @($timeoutResult.blocked_on) -contains "worker_timeout"
}
$timeoutRegression = [ordered]@{
    name = "07_timeout_regression"
    command = $timeoutCommand
    cwd = $projectRoot
    duration_seconds = [Math]::Round(((Get-Date) - $timeoutStarted).TotalSeconds, 3)
    exit_code = $timeoutExit
    timeout_or_not = $true
    result_classification = if ($timeoutBlockedOnOk) { "success" } else { "timeout_blocked_on_missing" }
    run_dir = if ($newRun.Count -gt 0) { $newRun[0] } else { $null }
    normalized_result = $timeoutResultPath
    blocked_on_contains_worker_timeout = $timeoutBlockedOnOk
}

$firstFailure = @($results | Where-Object { $_.result_classification -ne "success" } | Select-Object -First 1)
$rootCause = "unknown"
if ($results[0].result_classification -ne "success") {
    $rootCause = "claude_cli_unavailable"
} elseif ($results[1].timeout_or_not) {
    $rootCause = "claude_noninteractive_hangs"
} elseif ($results[1].result_classification -ne "success" -and $results[1].stderr_head -match "(?i)auth|login|trust") {
    $rootCause = "claude_auth_or_trust_required"
} elseif ($results[2].result_classification -eq "output_parsing_issue") {
    $rootCause = "output_parsing_issue"
} elseif ($results[4].timeout_or_not -or $results[5].timeout_or_not) {
    $rootCause = "permission_prompt_waiting"
} elseif ($results[1].result_classification -eq "success" -and ($results[4].result_classification -ne "success" -or $results[5].result_classification -ne "success")) {
    $rootCause = "permission_prompt_waiting"
}

$report = [ordered]@{
    created_at = (Get-Date).ToString("o")
    project_root = $projectRoot
    report_dir = $reportDir
    tests = @($results)
    timeout_regression = $timeoutRegression
    earliest_failed_test = if ($firstFailure.Count -gt 0) { $firstFailure[0].name } else { $null }
    most_likely_root_cause = $rootCause
    notes = @(
        "Diagnostics use Start-Job to match the harness invocation environment.",
        "No external directories, network setup, dependency installation, or git repair is performed by this script."
    )
}

$jsonPath = Join-Path $reportDir "worker-invocation-diagnostics.json"
$mdPath = Join-Path $reportDir "worker-invocation-diagnostics.md"
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

@"
# Worker Invocation Diagnostics

- Earliest failed test: $($report.earliest_failed_test)
- Claude version test: $($results[0].result_classification)
- Minimal text call: $($results[1].result_classification)
- Minimal JSON call: $($results[2].result_classification)
- Plan JSON call: $($results[3].result_classification)
- acceptEdits no-edit call: $($results[4].result_classification)
- Minimal edit call: $($results[5].result_classification)
- Timeout blocked_on regression: $($timeoutRegression.result_classification)
- Most likely root cause: $rootCause
- Report JSON: $jsonPath
"@ | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Host "Diagnostics JSON: $jsonPath"
Write-Host "Diagnostics Markdown: $mdPath"
if ($timeoutBlockedOnOk) { exit 0 } else { exit 1 }

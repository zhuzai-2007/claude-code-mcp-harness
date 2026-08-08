[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $repoRoot ".agent-runs\doctor-nvm-$PID"
$fakeNvm = Join-Path $testRoot "nvm"
$fakeVersion = Join-Path $fakeNvm "v24.15.0"
New-Item -ItemType Directory -Force -Path $fakeVersion | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $fakeNvm "nvm.exe"), (Join-Path $fakeVersion "node.exe") | Out-Null

try {
    $shell = if (Test-Path -LiteralPath (Join-Path $PSHOME "pwsh.exe")) { Join-Path $PSHOME "pwsh.exe" } else { Join-Path $PSHOME "powershell.exe" }
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $shell
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    $doctorPath = Join-Path $repoRoot "scripts\doctor.ps1"
    $runnerPath = Join-Path $testRoot "run-doctor.ps1"
    $fakeNvmLiteral = $fakeNvm.Replace("'", "''")
    $doctorPathLiteral = $doctorPath.Replace("'", "''")
    @"
`$env:PATH = '$fakeNvmLiteral'
`$env:NVM_HOME = '$fakeNvmLiteral'
& '$doctorPathLiteral' -Json
if (-not `$?) { exit 1 }
"@ | Set-Content -LiteralPath $runnerPath -Encoding UTF8
    $executionPolicy = if ($shell -like "*powershell.exe") { "-ExecutionPolicy Bypass " } else { "" }
    $start.Arguments = "-NoProfile $executionPolicy-File `"$runnerPath`""

    $process = [System.Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ([string]::IsNullOrWhiteSpace($stdout)) { throw "Doctor produced no JSON. stderr: $stderr" }
    $result = $stdout | ConvertFrom-Json
    $nodeChecks = @($result.checks | Where-Object name -eq "node")
    if ($nodeChecks.Count -eq 0) { throw "Doctor JSON did not contain a node check. stdout: $stdout stderr: $stderr" }
    $node = $nodeChecks[0]
    if ($node.status -ne "error" -or $node.ok) { throw "Node PATH check was unexpectedly relaxed." }
    if ($node.detail -notmatch [regex]::Escape($fakeNvm) -or $node.detail -notmatch "24\.15\.0") { throw "Doctor did not report nvm path and available version: $($node.detail)" }
    if ($node.advice -notmatch "nvm use 24\.15\.0") { throw "Doctor did not recommend the available nvm version: $($node.advice)" }
    if ($node.advice -match "Install Node\.js 20") { throw "Doctor incorrectly recommended reinstalling Node when nvm was detected." }
    if ($result.ok -or $result.status -ne "error") { throw "Doctor did not preserve its strict top-level failure result." }
    if ($process.ExitCode -eq 0) { throw "Doctor did not preserve its non-zero exit for a required PATH failure." }
    [pscustomobject]@{ ok = $true; strictFailurePreserved = ($process.ExitCode -ne 0); nvmPathReported = $true; suggestedVersion = "24.15.0" } | ConvertTo-Json
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

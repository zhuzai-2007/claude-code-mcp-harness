[CmdletBinding()]
param([switch] $Json)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'claude-task.ps1'
$results = New-Object System.Collections.Generic.List[object]
function Add-Result { param([string]$Name, [bool]$Passed, [string]$Detail) $script:results.Add([ordered]@{ name = $Name; passed = $Passed; detail = $Detail }) }

& powershell -NoProfile -ExecutionPolicy Bypass -File $script plan -Task 'smoke dry run' -DryRun *> $null
Add-Result 'dry-run' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"

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

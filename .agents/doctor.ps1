[CmdletBinding()]
param([switch] $Json)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FullPath { param([string] $Path) return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path) }

$agentsRoot = Resolve-FullPath $PSScriptRoot
$projectRoot = Resolve-FullPath (Join-Path $agentsRoot '..')
$claude = Get-Command claude -ErrorAction SilentlyContinue
$preferredRunRoot = Join-Path $agentsRoot 'runs'
$fallbackRunRoot = Join-Path $projectRoot '.agent-runs'
$runWrite = $false
$fallbackWrite = $false
$probe = Join-Path $preferredRunRoot ('.probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
try { Set-Content -LiteralPath $probe -Value 'probe' -Encoding UTF8; $runWrite = $true; try { Remove-Item -LiteralPath $probe -Force } catch { } } catch { $runWrite = $false }
$probe2 = Join-Path $fallbackRunRoot ('.probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
try { New-Item -ItemType Directory -Force -Path $fallbackRunRoot | Out-Null; Set-Content -LiteralPath $probe2 -Value 'probe' -Encoding UTF8; $fallbackWrite = $true; try { Remove-Item -LiteralPath $probe2 -Force } catch { } } catch { $fallbackWrite = $false }
$gitOk = $false
$gitMessage = ''
try {
    Push-Location -LiteralPath $projectRoot
    & git status --short *> $null
    $gitOk = ($LASTEXITCODE -eq 0)
    if (-not $gitOk) { $gitMessage = 'git status failed' }
} catch { $gitMessage = $_.Exception.Message } finally { Pop-Location }

$result = [ordered]@{
    status = if ($claude -and ($runWrite -or $fallbackWrite)) { 'ok' } else { 'degraded' }
    projectRoot = $projectRoot
    claudeOnPath = [bool]$claude
    claudePath = if ($claude) { $claude.Source } else { $null }
    preferredRunRootWritable = $runWrite
    fallbackRunRootWritable = $fallbackWrite
    gitRepositoryValid = $gitOk
    gitMessage = $gitMessage
    requiredClaudeArgs = @('--bare', '-p', '--permission-mode', '--output-format', '--max-budget-usd', '--system-prompt', '--allowedTools')
}
if ($Json) { $result | ConvertTo-Json -Depth 6; exit 0 }
Write-Host "Worker harness doctor: $($result.status)"
Write-Host "Project root: $projectRoot"
Write-Host "Claude on PATH: $($result.claudeOnPath) $($result.claudePath)"
Write-Host ".agents/runs writable: $runWrite"
Write-Host ".agent-runs fallback writable: $fallbackWrite"
Write-Host "Git repository valid: $gitOk $gitMessage"



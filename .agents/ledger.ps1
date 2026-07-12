[CmdletBinding()]
param(
    [int] $Tail = 20,
    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Resolve-FullPath { param([string] $Path) return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path) }

$agentsRoot = Resolve-FullPath $PSScriptRoot
$projectRoot = Resolve-FullPath (Join-Path $agentsRoot '..')
$ledgerPath = Join-Path $projectRoot '.agent-runs\project-ledger.jsonl'

if (-not (Test-Path -LiteralPath $ledgerPath)) {
    if ($Json) { [ordered]@{ ledgerPath = $ledgerPath; entries = @() } | ConvertTo-Json -Depth 6; exit 0 }
    Write-Host "No worker ledger found: $ledgerPath"
    exit 0
}

$lines = @(Get-Content -LiteralPath $ledgerPath -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($Tail -gt 0 -and $lines.Count -gt $Tail) { $lines = @($lines | Select-Object -Last $Tail) }
$entries = @($lines | ForEach-Object { $_ | ConvertFrom-Json })

if ($Json) {
    [ordered]@{ ledgerPath = $ledgerPath; entries = $entries } | ConvertTo-Json -Depth 10
    exit 0
}

foreach ($entry in $entries) {
    Write-Host "$($entry.recordedAt) $($entry.runId) [$($entry.mode)/$($entry.status)] $($entry.summary)"
    if ($entry.changes_made -and $entry.changes_made.Count -gt 0) { Write-Host "  Changes: $($entry.changes_made -join '; ')" }
    if ($entry.blocked_on -and $entry.blocked_on.Count -gt 0) { Write-Host "  Blocked: $($entry.blocked_on -join '; ')" }
}

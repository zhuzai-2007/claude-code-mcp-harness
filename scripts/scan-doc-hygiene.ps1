[CmdletBinding()]
param(
    [string] $ProjectRoot = ".",
    [string[]] $IncludePath = @("README.md", ".agents\README.md", "mcp-server\README.md", "docs", "skills\codex-claude-worker", "examples"),
    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-Root {
    param([string] $Path)
    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Add-Finding {
    param(
        [System.Collections.Generic.List[object]] $Findings,
        [string] $Path,
        [int] $LineNumber,
        [string] $Rule,
        [string] $Line
    )
    $Findings.Add([ordered]@{
        path = $Path
        line = $LineNumber
        rule = $Rule
        text = if ($Line.Length -gt 180) { $Line.Substring(0, 180) } else { $Line }
    })
}

function Get-RelativePathCompat {
    param([string] $BasePath, [string] $FullPath)
    $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $target = [System.IO.Path]::GetFullPath($FullPath)
    $baseUri = New-Object System.Uri($base)
    $targetUri = New-Object System.Uri($target)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

$root = Resolve-Root $ProjectRoot
$findings = New-Object System.Collections.Generic.List[object]
$extensions = @(".md", ".txt", ".yaml", ".yml")
$excludedParts = @("\workspace\", "\.agent-runs\", "\.agents\runs\", "\outbox\", "\logs\", "\node_modules\")
$excludedRelativePaths = @("docs\natural-language-smoke-results.md")
$files = New-Object System.Collections.Generic.List[string]

foreach ($relative in $IncludePath) {
    $candidate = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $item = Get-Item -LiteralPath $candidate
    if ($item.PSIsContainer) {
        Get-ChildItem -LiteralPath $item.FullName -Recurse -File | ForEach-Object {
            if ($extensions -contains $_.Extension.ToLowerInvariant()) { $files.Add($_.FullName) }
        }
    } elseif ($extensions -contains $item.Extension.ToLowerInvariant()) {
        $files.Add($item.FullName)
    }
}

$files = @($files | Sort-Object -Unique | Where-Object {
    $full = [System.IO.Path]::GetFullPath($_)
    $relative = Get-RelativePathCompat $root $full
    $inside = $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
    $excluded = $false
    foreach ($part in $excludedParts) {
        if ($full.IndexOf($part, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $excluded = $true; break }
    }
    foreach ($relativePath in $excludedRelativePaths) {
        if ($relative.Equals($relativePath, [System.StringComparison]::OrdinalIgnoreCase)) { $excluded = $true; break }
    }
    $inside -and -not $excluded
})

foreach ($file in $files) {
    $relativePath = Get-RelativePathCompat $root $file
    $lines = @(Get-Content -LiteralPath $file)
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = [string]$lines[$i]
        $lineNumber = $i + 1
        if ($line -match '[\u9200-\u9FFF]') {
            Add-Finding $findings $relativePath $lineNumber 'possible-mojibake' $line
        }
        if ($line -match '[A-Za-z]:\\(?:Users|agent_testing_field|agent|temp|tmp)\\') {
            Add-Finding $findings $relativePath $lineNumber 'real-local-path' $line
        }
        if ($line -match '(?i)[A-Za-z]:\\Users\\(?!<user>|<username>)[^\\/\s]+') {
            Add-Finding $findings $relativePath $lineNumber 'local-username' $line
        }
        if ($line -match 'https://(?!<ngrok-domain>|xxxx\.)[^\s`"<>]*ngrok[^\s`"<>]*') {
            Add-Finding $findings $relativePath $lineNumber 'real-ngrok-url' $line
        }
        if ($line -match '(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})') {
            Add-Finding $findings $relativePath $lineNumber 'token-looking-secret' $line
        }
    }
}

$findingArray = @()
foreach ($finding in $findings) { $findingArray += $finding }

$result = [ordered]@{
    ok = ($findings.Count -eq 0)
    checked = $files.Count
    findings = $findingArray
}

if ($Json) {
    $result | ConvertTo-Json -Depth 6
} else {
    if ($result.ok) {
        Write-Host "Doc hygiene: ok ($($files.Count) files checked)"
    } else {
        Write-Host "Doc hygiene: failed ($($findings.Count) findings)"
        foreach ($finding in $findings) {
            Write-Host "$($finding.path):$($finding.line) [$($finding.rule)] $($finding.text)"
        }
    }
}

if ($result.ok) { exit 0 } else { exit 1 }

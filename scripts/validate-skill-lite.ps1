[CmdletBinding()]
param(
    [string] $SkillPath = ".\skills\codex-claude-worker"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $SkillPath).Path)
$skill = Join-Path $root "SKILL.md"
$openaiYaml = Join-Path $root "agents\openai.yaml"

if (-not (Test-Path -LiteralPath $skill)) { throw "Missing SKILL.md: $skill" }
if (-not (Test-Path -LiteralPath $openaiYaml)) { throw "Missing agents/openai.yaml: $openaiYaml" }

$lines = @(Get-Content -LiteralPath $skill)
if ($lines.Count -lt 4) { throw "SKILL.md is too short." }
if ($lines[0] -ne "---") { throw "SKILL.md must start with YAML frontmatter." }
$closing = -1
for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq "---") { $closing = $i; break }
}
if ($closing -lt 1) { throw "SKILL.md frontmatter is not closed." }

$frontmatter = @($lines[1..($closing - 1)])
$nameLine = @($frontmatter | Where-Object { $_ -match '^name:\s*codex-claude-worker\s*$' })
$descriptionLine = @($frontmatter | Where-Object { $_ -match '^description:\s*.+' })
if ($nameLine.Count -ne 1) { throw "SKILL.md frontmatter must contain name: codex-claude-worker." }
if ($descriptionLine.Count -ne 1) { throw "SKILL.md frontmatter must contain a non-empty description." }

$yamlText = Get-Content -LiteralPath $openaiYaml -Raw
if ($yamlText -notmatch 'display_name:\s*"Codex Claude Worker"') { throw "openai.yaml display_name is missing or stale." }
if ($yamlText -notmatch 'default_prompt:\s*"Use \$codex-claude-worker ') { throw "openai.yaml default_prompt must mention `$codex-claude-worker." }

[ordered]@{
    ok = $true
    skillPath = $root
    checked = @("SKILL.md", "agents/openai.yaml")
} | ConvertTo-Json -Depth 4

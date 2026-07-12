[CmdletBinding()]
param(
    [string] $Profile = 'codex-claude-worker-noauth',
    [string] $McpServerUrl = 'http://127.0.0.1:8787/mcp',
    [string] $TunnelId,
    [ValidateSet('auto', 'no-auth', 'dcr')]
    [string] $AuthMode = 'auto',
    [string] $HealthBaseUrl = 'http://127.0.0.1:8080',
    [switch] $Initialize,
    [switch] $DoctorOnly,
    [switch] $ReadyOnly,
    [switch] $PrintConfiguration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$mcpConfigPath = Join-Path $repoRoot 'mcp-server\config.json'
$resolvedAuthMode = $AuthMode
if ($resolvedAuthMode -eq 'auto') {
    $requireAuth = $false
    if (Test-Path -LiteralPath $mcpConfigPath) {
        $mcpConfig = Get-Content -LiteralPath $mcpConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $mcpConfig.PSObject.Properties['requireAuth']) {
            $requireAuth = [bool]$mcpConfig.requireAuth
        }
    }
    $resolvedAuthMode = if ($requireAuth) { 'dcr' } else { 'no-auth' }
}
$sample = if ($resolvedAuthMode -eq 'no-auth') { 'sample_mcp_remote_no_auth' } else { 'sample_mcp_with_dcr' }

if ($PrintConfiguration) {
    [ordered]@{
        profile = $Profile
        authMode = $resolvedAuthMode
        sample = $sample
        mcpServerUrl = $McpServerUrl
        readyUrl = ($HealthBaseUrl.TrimEnd('/') + '/readyz')
    } | ConvertTo-Json -Depth 3
    exit 0
}

if ($ReadyOnly) {
    $ready = Invoke-WebRequest -UseBasicParsing -Uri ($HealthBaseUrl.TrimEnd('/') + '/readyz') -TimeoutSec 5
    if ($ready.StatusCode -ne 200) { throw "Tunnel ready check returned HTTP $($ready.StatusCode)." }
    Write-Host "Tunnel ready: $($ready.StatusCode) $($HealthBaseUrl.TrimEnd('/') + '/readyz')"
    exit 0
}

$tunnelClient = Get-Command tunnel-client -ErrorAction SilentlyContinue
if (-not $tunnelClient) {
    throw 'tunnel-client was not found on PATH. Download it from OpenAI Platform tunnel settings or the latest openai/tunnel-client release.'
}
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    throw 'CONTROL_PLANE_API_KEY is not set. Use a tunnel runtime API key; do not store it in this repository.'
}
if ($Initialize) {
    if ([string]::IsNullOrWhiteSpace($TunnelId)) { throw '-Initialize requires -TunnelId.' }
    & tunnel-client init --profile $Profile --sample $sample --tunnel-id $TunnelId --mcp-server-url $McpServerUrl
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client init failed with exit code $LASTEXITCODE." }
}

$doctorOutput = & tunnel-client doctor --profile $Profile --explain 2>&1 | Out-String
$doctorExitCode = $LASTEXITCODE
Write-Host $doctorOutput.TrimEnd()
if ($doctorExitCode -ne 0) {
    $doctorFailureLines = @(($doctorOutput -split "`r?`n") | Where-Object { $_ -match '(?i)\bFAIL(?:ED)?\b' })
    $unexpectedFailureLines = @($doctorFailureLines | Where-Object { $_ -notmatch '(?i)(oauth|well-known|protected-resource|discovery)' })
    $knownNoAuthDiscoveryMismatch = ($resolvedAuthMode -eq 'no-auth') -and
        ($doctorFailureLines.Count -gt 0) -and
        ($unexpectedFailureLines.Count -eq 0) -and
        ($doctorOutput -match '(?is)(oauth-protected-resource|well-known).*(404|not found)')
    if ($knownNoAuthDiscoveryMismatch) {
        Write-Warning 'tunnel-client doctor reported the known no-auth OAuth discovery 404. Continuing; verify /readyz after the client starts.'
    } else {
        throw "tunnel-client doctor failed with exit code $doctorExitCode."
    }
}
if ($DoctorOnly) { exit 0 }

if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_HTTP_PROXY)) {
    Write-Warning 'CONTROL_PLANE_HTTP_PROXY is not set. Set it when the OpenAI control plane must use a local proxy.'
}
Write-Host "Profile auth mode: $resolvedAuthMode (sample: $sample)"
Write-Host "Starting OpenAI Secure MCP Tunnel profile '$Profile'. Press Ctrl+C to stop it."
& tunnel-client run --profile $Profile
exit $LASTEXITCODE

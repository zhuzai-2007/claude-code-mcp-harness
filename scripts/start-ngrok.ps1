[CmdletBinding()]
param(
    [ValidateSet("auto", "ngrok", "cloudflared")]
    [string] $Provider = "auto",
    [int] $Port = 8787,
    [switch] $IUnderstandThisCreatesPublicIngress
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IUnderstandThisCreatesPublicIngress) {
    throw "Public tunnel disabled by default. Prefer scripts\start-openai-tunnel.ps1. To continue anyway, pass -IUnderstandThisCreatesPublicIngress."
}

function Find-Command {
    param([string] $Name)
    return Get-Command $Name -ErrorAction SilentlyContinue
}

$ngrok = Find-Command "ngrok"
$cloudflared = Find-Command "cloudflared"

if ($Provider -eq "auto") {
    if ($ngrok) {
        $Provider = "ngrok"
    } elseif ($cloudflared) {
        $Provider = "cloudflared"
    } else {
        throw "No tunnel provider found on PATH. Install ngrok or cloudflared, then run .\scripts\start-ngrok.ps1 again."
    }
}

Write-Host "Starting public tunnel for local MCP bridge on http://127.0.0.1:$Port/mcp"
Write-Warning "This creates public ingress to a write-capable MCP server without application authentication. Use only for isolated experiments."

if ($Provider -eq "ngrok") {
    if (-not $ngrok) { throw "ngrok is not available on PATH." }
    & ngrok http --host-header=127.0.0.1:$Port $Port
} elseif ($Provider -eq "cloudflared") {
    if (-not $cloudflared) { throw "cloudflared is not available on PATH." }
    & cloudflared tunnel --url "http://127.0.0.1:$Port"
}

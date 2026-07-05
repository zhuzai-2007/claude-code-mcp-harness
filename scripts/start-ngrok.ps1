[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Starting public ngrok tunnel for local MCP bridge."
Write-Host "Only use this in trusted sessions; the endpoint is public while the tunnel is active."
& ngrok http --host-header=127.0.0.1:8787 8787

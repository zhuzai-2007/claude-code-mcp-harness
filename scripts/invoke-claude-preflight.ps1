[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [string] $ArgumentsPath,
    [string] $InputPath,
    [string] $StdoutPath,
    [string] $StderrPath,
    [ValidateRange(1, 300)]
    [int] $TimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function ConvertTo-CommandLineArgument([string] $Value) {
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('"', '\"') + '"'
}

try {
    $shim = Get-Command claude -ErrorAction Stop | Select-Object -First 1
    $shimDirectory = Split-Path -Parent $shim.Source
    $claudeExecutable = Join-Path $shimDirectory "node_modules\@anthropic-ai\claude-code\bin\claude.exe"
    if (-not (Test-Path -LiteralPath $claudeExecutable -PathType Leaf)) {
        throw "Unable to resolve the Claude CLI executable from $($shim.Source)."
    }

    $parsedArguments = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $claudeArguments = @($parsedArguments | ForEach-Object { [string]$_ })
    if ($claudeArguments.Count -eq 0) { throw "Claude argument list must not be empty." }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $claudeExecutable
    $startInfo.Arguments = (($claudeArguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Claude CLI process did not start." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if ($InputPath -and (Test-Path -LiteralPath $InputPath)) {
        $process.StandardInput.Write((Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8))
    }
    $process.StandardInput.Close()

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch {}
        [System.IO.File]::WriteAllText($StdoutPath, "", $utf8NoBom)
        [System.IO.File]::WriteAllText($StderrPath, "SUPERVISOR_PREFLIGHT_TIMEOUT", $utf8NoBom)
        exit 124
    }
    $process.WaitForExit()
    [System.IO.File]::WriteAllText($StdoutPath, $stdoutTask.Result, $utf8NoBom)
    [System.IO.File]::WriteAllText($StderrPath, $stderrTask.Result, $utf8NoBom)
    exit $process.ExitCode
} catch {
    [System.IO.File]::WriteAllText($StderrPath, ($_ | Out-String), $utf8NoBom)
    [System.IO.File]::WriteAllText($StdoutPath, "", $utf8NoBom)
    exit 1
}

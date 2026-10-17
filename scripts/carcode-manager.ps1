<#
.SYNOPSIS
    CarCode AI local engineering manager (OpenAI manager -> Claude Code -> independent OpenAI review).

.DESCRIPTION
    Plans with the OpenAI manager model, hands each task to the Claude Code CLI,
    verifies the result, and requires a clean independent OpenAI review (a fresh,
    separate request) of the exact diff before committing. Stops at every
    human-approval gate. Never merges, deploys, force-pushes, or pushes to main.
    Codex is not required. See docs/agent-manager/README.md.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/carcode-manager.ps1 -Goal "Continue building CarCode"
#>
[CmdletBinding()]
param(
    [string]$Goal,
    [switch]$Once,
    [switch]$Autonomous,
    [switch]$DryRun,
    [switch]$Resume,
    [switch]$ReadOnly,
    [switch]$Status,
    [switch]$ClearState,
    [string]$Repo
)

$ErrorActionPreference = "Stop"

$selected = @(@{ n = "-Once"; v = $Once }, @{ n = "-Autonomous"; v = $Autonomous }, @{ n = "-DryRun"; v = $DryRun }, @{ n = "-Status"; v = $Status }, @{ n = "-ClearState"; v = $ClearState }) | Where-Object { $_.v }
if (@($selected).Count -gt 1) {
    throw "Choose at most one of -Once, -Autonomous, -DryRun, -Status, -ClearState."
}

$mode = "once"
if ($Autonomous) { $mode = "autonomous" }
if ($DryRun) { $mode = "dry-run" }
if ($Status) { $mode = "status" }
if ($ClearState) { $mode = "clear-state" }

$managerRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $managerRoot "tools\agent-manager\manager.mjs"
if (-not (Test-Path $entry)) {
    throw "Manager entry point not found: $entry"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 24 or newer is required (node was not found on PATH)."
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]") | Out-String).Trim()
if ($nodeMajor -lt 24) {
    throw "Node.js 24 or newer is required (found major version $nodeMajor)."
}

if (-not $Repo) {
    $Repo = (git -C $managerRoot rev-parse --show-toplevel)
}

$nodeArgs = @($entry, "--repo", $Repo, "--mode", $mode)
if ($Goal) {
    # Base64 avoids Windows PowerShell 5.1 native-argument quoting bugs.
    $nodeArgs += @("--goal-b64", [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Goal)))
}
if ($Resume) { $nodeArgs += "--resume" }
if ($ReadOnly) { $nodeArgs += "--read-only" }

& node @nodeArgs
exit $LASTEXITCODE

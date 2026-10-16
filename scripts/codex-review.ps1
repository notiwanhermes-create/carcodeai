param(
    [string]$Model = "gpt-6-astra"
)

$ErrorActionPreference = "Stop"

$repo = git rev-parse --show-toplevel
if (-not $repo) {
    throw "Not inside a Git repository."
}

Set-Location $repo

$reviewId = [guid]::NewGuid().ToString("N")
$outputFile = Join-Path $env:TEMP "carcode-codex-review-$reviewId.txt"

Write-Host ""
Write-Host "=== CODEX INDEPENDENT REVIEW ==="
Write-Host "Model: $Model"
Write-Host ""

try {
    codex exec review `
        --uncommitted `
        --ephemeral `
        -m $Model `
        -c 'sandbox_mode="read-only"' `
        -c 'windows.sandbox="unelevated"' `
        -o $outputFile

    if ($LASTEXITCODE -ne 0) {
        throw "Codex review failed with exit code $LASTEXITCODE."
    }

    Write-Host ""
    Write-Host "=== CODEX FINAL REVIEW ==="

    if (Test-Path $outputFile) {
        Get-Content $outputFile -Encoding UTF8
    } else {
        throw "Codex did not produce a review output file."
    }
}
finally {
    if (Test-Path $outputFile) {
        Remove-Item $outputFile -Force -ErrorAction SilentlyContinue
    }
}

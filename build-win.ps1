#Requires -Version 5.1
<#
.SYNOPSIS
    Builds the RiaCore desktop application for Windows (NSIS installer, x64).
.DESCRIPTION
    Installs dependencies, compiles all packages, and runs electron-builder to
    produce a Windows installer.  Output lands in:
        apps/desktop-host/dist-electron/
.EXAMPLE
    .\build-win.ps1
    .\build-win.ps1 -SkipInstall   # skip pnpm install if deps are already current
#>

param(
    [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
Push-Location $RepoRoot

function Step([string]$msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

try {
    # electron-builder extracts an archive containing macOS symlinks, which
    # requires the "Create Symbolic Links" privilege on Windows.
    # That privilege is granted automatically when Developer Mode is enabled.
    Step "Checking prerequisites"
    $devModeKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
    $devMode = Get-ItemProperty $devModeKey -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
    if (-not $devMode -or $devMode.AllowDevelopmentWithoutDevLicense -ne 1) {
        Write-Host "  [WARN] Windows Developer Mode is OFF." -ForegroundColor Yellow
        Write-Host "         electron-builder needs it to extract its signing-tools archive." -ForegroundColor Yellow
        Write-Host "         Enable it: Settings > System > For developers > Developer Mode" -ForegroundColor Yellow
        Write-Host "         (or run this script as Administrator)" -ForegroundColor Yellow
    } else {
        Write-Host "  Developer Mode: ON" -ForegroundColor DarkGray
    }

    Step "Checking pnpm"
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        # pnpm not in PATH - search conda envs, prefer the one with the newest Node
        $candidates = Get-ChildItem "$env:USERPROFILE\.conda\envs" -Filter "pnpm.cmd" `
                          -Recurse -Depth 2 -ErrorAction SilentlyContinue
        $best = $candidates | ForEach-Object {
            $nodeExe = Join-Path $_.DirectoryName "node.exe"
            if (Test-Path $nodeExe) {
                $ver = & $nodeExe --version 2>$null
                [PSCustomObject]@{ Cmd = $_; Version = $ver }
            }
        } | Sort-Object { [Version]($_.Version -replace '^v','') } -Descending |
            Select-Object -First 1
        if ($best) {
            Write-Host "  pnpm not in PATH; using: $($best.Cmd.FullName) (Node $($best.Version))" -ForegroundColor DarkYellow
            $env:PATH = "$($best.Cmd.DirectoryName);$env:PATH"
        } else {
            throw "pnpm not found. Activate your dev environment or install pnpm: https://pnpm.io/installation"
        }
    }
    $pnpmVer = pnpm --version
    Write-Host "  pnpm $pnpmVer" -ForegroundColor DarkGray

    Step "Checking Node and pnpm versions"
    $expectedNode = node -p "require('./package.json').engines.node"
    $expectedPnpm = node -p "require('./package.json').engines.pnpm"
    $actualNode = node -p "process.version.slice(1)"
    $actualPnpm = $pnpmVer
    if ($actualNode -ne $expectedNode) {
        throw "Node $expectedNode is required; found $actualNode"
    }
    if ($actualPnpm -ne $expectedPnpm) {
        throw "pnpm $expectedPnpm is required; found $actualPnpm"
    }
    Write-Host "  Node $actualNode, pnpm $actualPnpm" -ForegroundColor DarkGray

    if (-not $SkipInstall) {
        Step "Installing dependencies from the lockfile"
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "pnpm install --frozen-lockfile failed" }
    }

    Step "Building core packages + desktop host + renderer"
    pnpm package:desktop:win
    if ($LASTEXITCODE -ne 0) { throw "Build/package step failed" }

    $OutDir = Join-Path $RepoRoot "apps\desktop-host\dist-electron"
    Step "Done - artifacts in: $OutDir"
    if (Test-Path $OutDir) {
        Get-ChildItem $OutDir -File | Select-Object Name, @{n='Size(MB)';e={[math]::Round($_.Length/1MB,1)}}
    }
}
catch {
    Write-Host "`n[ERROR] $_" -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
}

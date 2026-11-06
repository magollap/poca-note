#Requires -Version 5.1
<#
.SYNOPSIS
  Install poca-note on Windows, macOS, or Linux.

.DESCRIPTION
  Reads requirements.txt, checks Node.js and npm, installs the npm packages,
  creates .env and data/, and builds web/dist. It never edits an existing .env
  or deletes application data.

.PARAMETER Dev
  Set up for development and skip the production build.

.PARAMETER Start
  Start the app after installing.

.PARAMETER Test
  Run the test suite after installing.

.PARAMETER InstallNode
  Try to install Node.js with winget, Chocolatey, or Homebrew.

.PARAMETER SkipInstall
  Do not run npm ci / npm install.

.PARAMETER SkipBuild
  Do not build web/dist.

.PARAMETER SkipEnv
  Do not create .env from .env.example.

.PARAMETER Force
  Reinstall dependencies with npm ci.

.EXAMPLE
  .\scripts\install.ps1

.EXAMPLE
  .\scripts\install.ps1 -Dev -Start

.EXAMPLE
  .\scripts\install.ps1 -InstallNode -Start
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [switch]$Start,
  [switch]$Test,
  [switch]$InstallNode,
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$SkipEnv,
  [switch]$Force,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

$script:Root = Split-Path -Parent $PSScriptRoot
$script:RequirementsFile = Join-Path $script:Root "requirements.txt"

function Write-InfoLine {
  param([string]$Message)
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-OkLine {
  param([string]$Message)
  Write-Host "  OK  $Message" -ForegroundColor Green
}

function Write-WarnLine {
  param([string]$Message)
  Write-Host "  !!  $Message" -ForegroundColor Yellow
}

function Write-ErrLine {
  param([string]$Message)
  Write-Host "  XX  $Message" -ForegroundColor Red
}

function Show-Help {
  @"
poca-note installer (Windows / macOS / Linux)

Usage:
  .\scripts\install.ps1 [options]

Options:
  -Dev            Set up for development and skip the production build
  -Start          Start the app after installing
  -Test           Run the test suite after installing
  -InstallNode    Try to install Node.js with winget/choco/brew
  -SkipInstall    Do not run npm ci / npm install
  -SkipBuild      Do not build web/dist
  -SkipEnv        Do not create .env from .env.example
  -Force          Reinstall dependencies with npm ci
  -Help           Show this help

Examples:
  .\scripts\install.ps1
  .\scripts\install.ps1 -Dev -Start
  .\scripts\install.ps1 -InstallNode -Start
"@ | Write-Host
}

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-OsName {
  if ($env:OS -eq "Windows_NT") { return "Windows" }
  if (Test-Command "uname") {
    $value = (& uname -s 2>$null)
    if ($value) { return ([string]$value).Trim() }
  }
  return "Unknown"
}

function Get-CommandVersion {
  param([string]$Name)
  try {
    $raw = & $Name --version 2>$null | Select-Object -First 1
    if (-not $raw) { return $null }
    $match = [regex]::Match([string]$raw, '\d+(\.\d+)+')
    if ($match.Success) { return $match.Value }
    return $null
  } catch {
    return $null
  }
}

function ConvertTo-NumericVersion {
  param([string]$Value)
  $clean = ([string]$Value).Trim()
  $clean = $clean -replace '^[vV]', ''
  if ($clean -notmatch '^\d+(\.\d+)*$') {
    throw "Invalid version '$Value'."
  }
  $parts = @($clean.Split('.'))
  while ($parts.Count -lt 4) { $parts += "0" }
  if ($parts.Count -gt 4) { $parts = $parts[0..3] }
  return [version]($parts -join '.')
}

function Test-Version {
  param(
    [string]$Actual,
    [string]$Operator,
    [string]$Required
  )
  try {
    $a = ConvertTo-NumericVersion $Actual
    $r = ConvertTo-NumericVersion $Required
  } catch {
    return $false
  }
  switch ($Operator) {
    ">=" { return ($a -ge $r) }
    ">" { return ($a -gt $r) }
    "<=" { return ($a -le $r) }
    "<" { return ($a -lt $r) }
    "=" { return ($a -eq $r) }
    default { return $false }
  }
}

function Read-Requirements {
  if (-not (Test-Path -LiteralPath $script:RequirementsFile)) {
    throw "requirements.txt not found at $script:RequirementsFile"
  }

  $items = New-Object System.Collections.Generic.List[object]
  foreach ($raw in Get-Content -LiteralPath $script:RequirementsFile) {
    $line = ($raw -replace '#.*$', '').Trim()
    if (-not $line) { continue }
    if ($line -match '^(require|optional|npm):(.+)$') {
      $kind = $Matches[1]
      $rest = $Matches[2].Trim()
      $parts = $rest -split '\s+', 2
      $name = $parts[0]
      $spec = ""
      if ($parts.Count -gt 1) { $spec = $parts[1].Trim() }
      $items.Add([pscustomobject]@{ Kind = $kind; Name = $name; Spec = $spec })
    }
  }
  return $items
}

function Test-SystemRequirement {
  param($Item)

  $op = ">="
  $want = $Item.Spec
  if ($Item.Spec -match '^([<>=]+)\s*(.+)$') {
    $op = $Matches[1]
    $want = $Matches[2].Trim()
  }
  if (-not $want) {
    $op = ">="
    $want = "0"
  }

  if (-not (Test-Command $Item.Name)) {
    Write-ErrLine "$($Item.Name) is not installed (need $op$want)."
    return $false
  }

  $actual = Get-CommandVersion $Item.Name
  if (-not $actual) {
    Write-ErrLine "Could not determine $($Item.Name) version."
    return $false
  }

  if (-not (Test-Version $actual $op $want)) {
    Write-ErrLine "$($Item.Name) $actual is too old (need $op$want)."
    return $false
  }

  Write-OkLine "$($Item.Name) $actual (need $op$want)"
  return $true
}

function Show-OptionalRequirement {
  param($Item)
  if (Test-Command $Item.Name) {
    $actual = Get-CommandVersion $Item.Name
    if ($actual) {
      Write-OkLine "$($Item.Name) $actual (optional)"
    } else {
      Write-OkLine "$($Item.Name) found (optional)"
    }
  } else {
    Write-WarnLine "$($Item.Name) not found (optional; SQLite is the default)."
  }
}

function Install-NodeRuntime {
  $os = Get-OsName
  switch ($os) {
    "Windows" {
      if (Test-Command "winget") {
        Write-InfoLine "Installing Node.js LTS with winget..."
        & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
      } elseif (Test-Command "choco") {
        Write-InfoLine "Installing Node.js LTS with Chocolatey..."
        & choco install nodejs-lts -y
      } else {
        Write-ErrLine "Install Node.js 22.13+ from https://nodejs.org/ or install winget/Chocolatey."
        return $false
      }
      # A fresh install may not be visible in this process yet.
      $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
      $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
      $pathParts = @($machinePath, $userPath) | Where-Object { $_ }
      $env:Path = ($pathParts -join ";")
    }
    "Darwin" {
      if (Test-Command "brew") {
        Write-InfoLine "Installing Node.js with Homebrew..."
        & brew install node
      } else {
        Write-ErrLine "Install Homebrew (https://brew.sh) or Node.js 22.13+ from https://nodejs.org/."
        return $false
      }
    }
    "Linux" {
      if (Test-Command "apt-get") {
        Write-WarnLine "On Debian/Ubuntu, install Node.js 22.13+ with NodeSource:"
        Write-Host "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
        Write-Host "  sudo apt-get install -y nodejs"
      } elseif (Test-Command "dnf") {
        Write-Host "  sudo dnf install -y nodejs npm"
      } elseif (Test-Command "pacman") {
        Write-Host "  sudo pacman -S --needed nodejs npm"
      } else {
        Write-Host "  Install Node.js 22.13+ from https://nodejs.org/."
      }
      return $false
    }
    default {
      Write-ErrLine "Unsupported OS: $os. Install Node.js 22.13+ manually."
      return $false
    }
  }

  return (Test-Command "node")
}

function Invoke-Npm {
  param([string[]]$NpmArgs)
  & npm @NpmArgs
  if ($LASTEXITCODE -ne 0) {
    throw "npm $($NpmArgs -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Install-Dependencies {
  Push-Location -LiteralPath $script:Root
  try {
    $lock = Join-Path $script:Root "package-lock.json"
    $modules = Join-Path $script:Root "node_modules"

    if ((Test-Path -LiteralPath $lock) -and ((-not (Test-Path -LiteralPath $modules)) -or $Force)) {
      Write-InfoLine "Installing npm dependencies with npm ci..."
      try {
        Invoke-Npm @("ci", "--no-audit", "--no-fund")
      } catch {
        Write-WarnLine "npm ci failed; falling back to npm install."
        Invoke-Npm @("install", "--no-audit", "--no-fund")
      }
    } else {
      Write-InfoLine "Installing npm dependencies with npm install..."
      Invoke-Npm @("install", "--no-audit", "--no-fund")
    }
  } finally {
    Pop-Location
  }
}

function Assert-NpmPackages {
  param($Items)

  $missing = @()
  foreach ($item in @($Items | Where-Object { $_.Kind -eq "npm" })) {
    $pkgPath = Join-Path (Join-Path (Join-Path $script:Root "node_modules") $item.Name) "package.json"
    if (-not (Test-Path -LiteralPath $pkgPath)) {
      $missing += $item.Name
    }
  }

  if ($missing.Count -gt 0) {
    throw "Missing npm packages: $($missing -join ', '). Run npm install again."
  }
  Write-OkLine "All npm packages from requirements.txt are present."
}

function Initialize-Env {
  $envFile = Join-Path $script:Root ".env"
  $example = Join-Path $script:Root ".env.example"
  if ((Test-Path -LiteralPath $example) -and -not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath $example -Destination $envFile
    Write-OkLine "Created .env from .env.example."
  } elseif (Test-Path -LiteralPath $envFile) {
    Write-OkLine ".env already exists; leaving it untouched."
  }
}

function Build-Web {
  Push-Location -LiteralPath $script:Root
  try {
    Write-InfoLine "Building the web UI..."
    Invoke-Npm @("run", "build")
    Write-OkLine "Web UI built into web/dist."
  } finally {
    Pop-Location
  }
}

function Start-App {
  Push-Location -LiteralPath $script:Root
  try {
    if ($Dev) {
      Write-InfoLine "Starting development servers (API :8787, Vite :5173)..."
      Invoke-Npm @("run", "dev")
    } else {
      Write-InfoLine "Starting poca-note in production mode..."
      $env:NODE_ENV = "production"
      Invoke-Npm @("start")
    }
  } finally {
    Pop-Location
  }
}

if ($Help) {
  Show-Help
  exit 0
}

Write-Host ""
Write-Host "poca-note installer" -ForegroundColor Cyan
Write-InfoLine "Project: $script:Root"

$osName = Get-OsName
if ($osName -ne "Windows" -and (Test-Command "id")) {
  $uid = (& id -u 2>$null)
  if ($uid -and ([string]$uid).Trim() -eq "0") {
    Write-WarnLine "You are running as root. Prefer your normal user so node_modules and data stay writable by you."
    Write-WarnLine ('If you already ran this with sudo, fix ownership: sudo chown -R $USER:$USER ' + $script:Root)
  }
}

try {
  $items = @(Read-Requirements)
} catch {
  Write-ErrLine $_.Exception.Message
  exit 1
}

$systemItems = @($items | Where-Object { $_.Kind -eq "require" })
$optionalItems = @($items | Where-Object { $_.Kind -eq "optional" })
$npmItems = @($items | Where-Object { $_.Kind -eq "npm" })

Write-InfoLine "Checking system requirements..."
$failed = @()
foreach ($item in $systemItems) {
  if (-not (Test-SystemRequirement $item)) {
    $failed += $item.Name
  }
}

if ($failed.Count -gt 0) {
  if ($InstallNode -and ($failed -contains "node")) {
    Write-InfoLine "Attempting to install Node.js..."
    if (Install-NodeRuntime) {
      Write-InfoLine "Re-checking requirements..."
      $failed = @()
      foreach ($item in $systemItems) {
        if (-not (Test-SystemRequirement $item)) {
          $failed += $item.Name
        }
      }
    }
  }
}

if ($failed.Count -gt 0) {
  Write-ErrLine "Missing requirements: $($failed -join ', ')."
  Write-Host "Install them and re-run this script."
  Write-Host "Tip: use -InstallNode to let the script install Node.js where supported."
  exit 1
}

foreach ($item in $optionalItems) {
  Show-OptionalRequirement $item
}

if ($SkipInstall) {
  Write-WarnLine "Skipping dependency installation."
} else {
  Install-Dependencies
  Assert-NpmPackages $npmItems
}

if ($SkipEnv) {
  Write-WarnLine "Skipping .env setup."
} else {
  Initialize-Env
}

New-Item -ItemType Directory -Force -Path (Join-Path $script:Root "data") | Out-Null

if ($Dev) {
  Write-WarnLine "Dev mode: skipping the production build."
} elseif ($SkipBuild) {
  Write-WarnLine "Skipping the production build."
} else {
  Build-Web
}

if (-not (Test-Path -LiteralPath (Join-Path $script:Root "web/dist/index.html"))) {
  Write-WarnLine "web/dist/index.html is missing. Run npm run build before npm start."
}

if ($Test) {
  Write-InfoLine "Running tests..."
  Push-Location -LiteralPath $script:Root
  try {
    Invoke-Npm @("test")
  } finally {
    Pop-Location
  }
}

if ($Start) {
  Start-App
} else {
  Write-Host ""
  Write-OkLine "Installation complete."
  Write-Host ""
  Write-WarnLine "The app is NOT running yet. Nothing is listening on the port until you start it."
  Write-Host ""
  if ($Dev) {
    Write-Host "  Start development:  npm run dev"
    Write-Host "  Then open:          http://localhost:5173"
  } else {
    Write-Host "  Start production:   npm start"
    Write-Host "  Then open:          http://localhost:8787"
  }
  Write-Host ""
  Write-Host "  Start it automatically next time:  .\scripts\install.ps1 -Start"
  Write-Host "  Demo login:         acme / poca-demo (only on a fresh database)"
  Write-Host "  Configuration:      .env"
  Write-Host "  Keep the server terminal open; press Ctrl+C to stop."
  Write-Host "  From another machine: http://<server-ip>:8787 (allow the port in your firewall)."
}

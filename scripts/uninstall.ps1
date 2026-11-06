#Requires -Version 5.1
<#
.SYNOPSIS
  Uninstall poca-note on Windows, macOS, or Linux.

.DESCRIPTION
  Removes node_modules/ and web/dist/. With -Purge it also removes .env,
  .env.local, and data/ (the database and its backups). Source code, tests, and
  README.md are never deleted.

.PARAMETER Purge
  Also remove .env, .env.local, and data/.

.PARAMETER Stop
  Stop a running poca-note server before removing files.

.PARAMETER DryRun
  Show what would be removed without deleting anything.

.PARAMETER Yes
  Skip the confirmation prompt.

.PARAMETER Help
  Show the help text.

.EXAMPLE
  .\scripts\uninstall.ps1 -DryRun

.EXAMPLE
  .\scripts\uninstall.ps1

.EXAMPLE
  .\scripts\uninstall.ps1 -Stop -Purge -Yes
#>
[CmdletBinding()]
param(
  [switch]$Purge,
  [switch]$Stop,
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

$script:Root = Split-Path -Parent $PSScriptRoot

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
poca-note uninstaller (Windows / macOS / Linux)

Usage:
  .\scripts\uninstall.ps1 [options]

By default this removes node_modules\ and web\dist\ and keeps your data.

Options:
  -Purge     Also remove .env, .env.local, and data\ (database + backups)
  -Stop      Stop a running poca-note server before removing files
  -DryRun    Show what would be removed without deleting anything
  -Yes       Skip the confirmation prompt
  -Help      Show this help

Examples:
  .\scripts\uninstall.ps1 -DryRun
  .\scripts\uninstall.ps1
  .\scripts\uninstall.ps1 -Purge
  .\scripts\uninstall.ps1 -Stop -Purge -Yes
"@ | Write-Host
}

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Refuse to touch anything that is not this project.
function Assert-Project {
  $pkg = Join-Path $script:Root "package.json"
  if (-not (Test-Path -LiteralPath $pkg)) {
    throw "No package.json in $script:Root; refusing to continue."
  }
  $json = Get-Content -LiteralPath $pkg -Raw
  if ($json -notmatch '"name"\s*:\s*"poca-note"') {
    throw "This does not look like the poca-note project ($script:Root)."
  }
}

function Get-EnvValue {
  param([string]$Key)
  $file = Join-Path $script:Root ".env"
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  foreach ($raw in Get-Content -LiteralPath $file) {
    if ($raw -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
      $value = $Matches[1].Trim()
      $value = $value.Trim('"').Trim("'")
      return $value
    }
  }
  return $null
}

function Test-PortOpen {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-ListeningPid {
  param([int]$Port)

  if (Test-Command "Get-NetTCPConnection") {
    try {
      $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
        Select-Object -First 1
      if ($conn) { return [int]$conn.OwningProcess }
    } catch {
      # Fall through to the other probes.
    }
  }

  if (Test-Command "lsof") {
    $value = & lsof -ti "tcp:$Port" -sTCP:LISTEN 2>$null | Select-Object -First 1
    if ($value) { return [int]([string]$value).Trim() }
  }

  if (Test-Command "ss") {
    $line = & ss -ltnp 2>$null | Where-Object { $_ -match ":$Port\b" } | Select-Object -First 1
    if ($line -and ($line -match "pid=(\d+)")) { return [int]$Matches[1] }
  }

  return $null
}

function Get-AppPid {
  param([int]$Port)

  # Note: $PID is a read-only automatic variable, so use a different name.
  $owner = Get-ListeningPid -Port $Port
  if ($owner) { return $owner }

  try {
    $process = Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'start\.mjs|server/index\.js|dev\.mjs' } |
      Select-Object -First 1
    if ($process) { return [int]$process.ProcessId }
  } catch {
    # Not available on every platform; ignore.
  }

  if (Test-Command "pgrep") {
    $value = & pgrep -f "scripts/start.mjs" 2>$null | Select-Object -First 1
    if ($value) { return [int]([string]$value).Trim() }
  }

  return $null
}

function Stop-Server {
  param([int]$Port)

  if (-not (Test-PortOpen -Port $Port)) {
    Write-OkLine "Nothing is listening on port $Port."
    return $true
  }

  $targetPid = Get-AppPid -Port $Port
  if (-not $targetPid) {
    Write-WarnLine "Port $Port is in use, but the owning process could not be identified."
    Write-WarnLine "Stop it manually and re-run this script."
    return $false
  }

  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -and $proc.ProcessName -notmatch '^node') {
    Write-ErrLine "Process $targetPid ($($proc.ProcessName)) does not look like poca-note."
    Write-ErrLine "Stop it manually and re-run this script."
    return $false
  }

  Write-InfoLine "Stopping poca-note (pid $targetPid)..."
  try {
    Stop-Process -Id $targetPid -Force -ErrorAction Stop
  } catch {
    Write-ErrLine "Could not stop process $targetPid : $($_.Exception.Message)"
    return $false
  }

  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Test-PortOpen -Port $Port)) {
      Write-OkLine "Server stopped."
      return $true
    }
    Start-Sleep -Milliseconds 250
  }

  if (Test-PortOpen -Port $Port) {
    Write-ErrLine "Port $Port is still in use."
    return $false
  }
  Write-OkLine "Server stopped."
  return $true
}

function Get-PathSize {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return "0 B" }
  try {
    $bytes = (Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { return "0 B" }
    if ($bytes -ge 1GB) { return "{0:N1} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N1} KB" -f ($bytes / 1KB) }
    return "$bytes B"
  } catch {
    return "unknown"
  }
}

if ($Help) {
  Show-Help
  exit 0
}

Write-Host ""
Write-Host "poca-note uninstaller" -ForegroundColor Cyan
Write-InfoLine "Project: $script:Root"

try {
  Assert-Project
} catch {
  Write-ErrLine $_.Exception.Message
  exit 1
}

$envPort = Get-EnvValue "PORT"
$port = 8787
if ($envPort -and ($envPort -match '^\d+$')) { $port = [int]$envPort }

$targets = @(
  (Join-Path $script:Root "node_modules"),
  (Join-Path $script:Root "web/dist")
)
if ($Purge) {
  $targets += @(
    (Join-Path $script:Root ".env"),
    (Join-Path $script:Root ".env.local"),
    (Join-Path $script:Root "data")
  )
}

$existing = @($targets | Where-Object { Test-Path -LiteralPath $_ })

if ($existing.Count -eq 0) {
  Write-OkLine "Nothing to remove; this install is already clean."
  if ($Purge) {
    Write-Host "  Dependencies, web build, .env, and data are all gone."
  }
  exit 0
}

Write-InfoLine "The following will be removed:"
foreach ($target in $existing) {
  $relative = $target.Substring($script:Root.Length).TrimStart('\', '/')
  Write-Host ("    {0} ({1})" -f $relative, (Get-PathSize $target))
}

if ($Purge) {
  Write-WarnLine "This deletes your database and every backup in data\."
} else {
  Write-Host ""
  Write-OkLine "Keeping .env and data\ (database, backups, settings)."
  Write-Host "     Use -Purge to delete them too."
}

if ($DryRun) {
  Write-Host ""
  Write-OkLine "Dry run: nothing was deleted."
  exit 0
}

if (-not $Yes) {
  Write-Host ""
  $reply = Read-Host "Continue? [y/N]"
  if ($reply -notmatch '^(y|yes)$') {
    Write-WarnLine "Cancelled. Nothing was deleted."
    exit 1
  }
}

if ($Stop) {
  Stop-Server -Port $port | Out-Null
} elseif (Test-PortOpen -Port $port) {
  Write-WarnLine "poca-note is still running on port $port."
  Write-WarnLine "Stop it first (or re-run with -Stop); deleting files under a running server can leave it unstable."
}

foreach ($target in $existing) {
  $relative = $target.Substring($script:Root.Length).TrimStart('\', '/')
  Write-InfoLine "Removing $relative..."
  try {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
  } catch {
    Write-ErrLine "Failed to remove $target : $($_.Exception.Message)"
    Write-ErrLine "Close any program using those files and try again."
    exit 1
  }
}

Write-Host ""
Write-OkLine "Uninstalled poca-note from $script:Root."
if ($Purge) {
  $parent = Split-Path -Parent $script:Root
  $leaf = Split-Path -Leaf $script:Root
  Write-Host "  Dependencies, the web build, .env, and data are gone."
  Write-Host "  Remove the remaining source files with:"
  Write-Host ("    Remove-Item -Recurse -Force `"{0}`"" -f $script:Root)
  if ($parent -and $leaf) {
    Write-Host ("    # or: cd `"{0}`"; Remove-Item -Recurse -Force `"{1}`"" -f $parent, $leaf)
  }
} else {
  Write-Host "  Dependencies and the web build are gone; your data is untouched."
  Write-Host "  Remove .env and data as well:  .\scripts\uninstall.ps1 -Purge"
  Write-Host "  Reinstall:                     .\scripts\install.ps1"
}

param(
    [switch]$China,
    [string]$Registry = "",
    [string]$BunVersion = "1.3.5"
)

# Spark Code Windows installer.
# Bootstraps Bun, installs dependencies, and creates a user-level sparkc command.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$PathChanged = $false
$DefaultRegistry = if ($China) { "https://registry.npmmirror.com" } else { "https://registry.npmjs.org" }
$InstallRegistry = if ($Registry) { $Registry.TrimEnd('/') } else { $DefaultRegistry }
$BunMirrorBase = if ($China) { "https://registry.npmmirror.com/-/binary/bun" } else { "https://github.com/oven-sh/bun/releases/download" }

Set-Location $ProjectRoot

function Write-Info($Message) {
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Ok($Message) {
    Write-Host $Message -ForegroundColor Green
}

function Write-Warn($Message) {
    Write-Host $Message -ForegroundColor Yellow
}

function Add-UserPath($Dir) {
    if (-not (Test-Path $Dir)) {
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    }

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($currentUserPath) {
        $parts = $currentUserPath -split ';' | Where-Object { $_ -and $_.Trim() -ne "" }
    }

    $alreadyExists = $false
    foreach ($part in $parts) {
        if ($part.TrimEnd('\') -ieq $Dir.TrimEnd('\')) {
            $alreadyExists = $true
            break
        }
    }

    if (-not $alreadyExists) {
        $newUserPath = if ($currentUserPath) { "$Dir;$currentUserPath" } else { $Dir }
        [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
        $script:PathChanged = $true
    }

    if (($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }).Count -eq 0) {
        $env:Path = "$Dir;$env:Path"
    }
}

function Get-BundledBunPath {
    $bundled = Join-Path $ProjectRoot "runtime\win32-x64\bun.exe"
    if (Test-Path $bundled) {
        return $bundled
    }
    return $null
}

function Get-BunPath {
    $bundled = Get-BundledBunPath
    if ($bundled) {
        return $bundled
    }

    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    $candidates = @(
        (Join-Path $env:USERPROFILE ".bun\bin\bun.exe"),
        (Join-Path $env:LOCALAPPDATA "bun\bun.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

function Expand-BunArchive($ArchivePath, $TargetDir) {
    if (Test-Path $TargetDir) {
        Remove-Item -Recurse -Force $TargetDir
    }
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

    $extractDir = Join-Path $env:TEMP ("sparkcode-bun-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    try {
        Expand-Archive -Path $ArchivePath -DestinationPath $extractDir -Force
        $bunExe = Get-ChildItem -Path $extractDir -Filter "bun.exe" -Recurse | Select-Object -First 1
        if (-not $bunExe) {
            throw "bun.exe not found in archive"
        }
        Copy-Item $bunExe.FullName (Join-Path $TargetDir "bun.exe") -Force
    }
    finally {
        Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
    }
}

function Install-BunFromZip($Url, $TargetDir) {
    $archivePath = Join-Path $env:TEMP ("sparkcode-bun-" + [guid]::NewGuid().ToString("N") + ".zip")

    try {
        Write-Info "Downloading Bun: $Url"
        Invoke-WebRequest -Uri $Url -OutFile $archivePath
        Expand-BunArchive $archivePath $TargetDir
        return Join-Path $TargetDir "bun.exe"
    }
    finally {
        Remove-Item -Force $archivePath -ErrorAction SilentlyContinue
    }
}

function Install-Bun {
    Write-Warn "Bun not found. Installing Bun for the current user..."

    $userBunDir = Join-Path $env:USERPROFILE ".bun\bin"
    $bunZip = "$BunMirrorBase/bun-v$BunVersion/bun-windows-x64.zip"

    try {
        $bun = Install-BunFromZip $bunZip $userBunDir
        Add-UserPath $userBunDir
        Write-Ok "Bun installed: $(& $bun --version)"
        return $bun
    }
    catch {
        Write-Host "Failed to install Bun automatically." -ForegroundColor Red
        if ($China) {
            Write-Host "国内网络可手动下载 Bun: https://registry.npmmirror.com/-/binary/bun/bun-v$BunVersion/bun-windows-x64.zip" -ForegroundColor Gray
            Write-Host "解压后把 bun.exe 放到 %USERPROFILE%\.bun\bin，再运行 install-cn.cmd。" -ForegroundColor Gray
        }
        else {
            Write-Host "Open https://bun.sh/docs/installation and install Bun, then run install.cmd again." -ForegroundColor Gray
        }
        exit 1
    }
}

function Write-LocalLauncher {
    $launcherPath = Join-Path $ProjectRoot "sparkc.cmd"
    $content = @'
@echo off
setlocal
set "SPARK_CODE_ROOT=%~dp0"

if exist "%SPARK_CODE_ROOT%runtime\win32-x64\bun.exe" (
  set "BUN=%SPARK_CODE_ROOT%runtime\win32-x64\bun.exe"
) else if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
) else (
  set "BUN=bun"
)

"%BUN%" run "%SPARK_CODE_ROOT%src\dev-entry.ts" %*
exit /b %ERRORLEVEL%
'@
    Set-Content -Path $launcherPath -Value $content -Encoding ASCII
    return $launcherPath
}

function Write-GlobalLauncher {
    $binDir = Join-Path $env:LOCALAPPDATA "SparkCode\bin"
    if (-not (Test-Path $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }

    $launcherPath = Join-Path $binDir "sparkc.cmd"
    $escapedProjectRoot = $ProjectRoot.TrimEnd('\')
    $content = @"
@echo off
setlocal
set "SPARK_CODE_ROOT=$escapedProjectRoot"

if exist "%SPARK_CODE_ROOT%\runtime\win32-x64\bun.exe" (
  set "BUN=%SPARK_CODE_ROOT%\runtime\win32-x64\bun.exe"
) else if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
) else (
  set "BUN=bun"
)

"%BUN%" run "%SPARK_CODE_ROOT%\src\dev-entry.ts" %*
exit /b %ERRORLEVEL%
"@
    Set-Content -Path $launcherPath -Value $content -Encoding ASCII
    Add-UserPath $binDir
    return $launcherPath
}

function Write-InstallConfig {
    $bunfigPath = Join-Path $ProjectRoot "bunfig.toml"
    $content = @"
[install]
registry = "$InstallRegistry"
"@
    Set-Content -Path $bunfigPath -Value $content -Encoding ASCII
    return $bunfigPath
}

Write-Info "=== Spark Code Windows installer ==="
Write-Host "Project:  $ProjectRoot" -ForegroundColor Gray
Write-Host "Registry: $InstallRegistry" -ForegroundColor Gray
if ($China) {
    Write-Host "Network:  China mirror mode" -ForegroundColor Gray
}
Write-Host ""

$bun = Get-BunPath
if ($bun) {
    if (-not (Get-BundledBunPath)) {
        Add-UserPath (Split-Path -Parent $bun)
    }
    Write-Ok "Bun found: $(& $bun --version)"
}
else {
    $bun = Install-Bun
}

Write-Host ""
Write-Info "Installing dependencies..."
if (-not (Test-Path (Join-Path $ProjectRoot "bun.lock"))) {
    Write-Warn "bun.lock was not found. Dependency versions may drift."
}

$bunfigPath = Write-InstallConfig
Write-Host "bunfig:   $bunfigPath" -ForegroundColor Gray

& $bun install --registry $InstallRegistry --network-concurrency 16
Write-Ok "Dependencies installed."

Write-Host ""
Write-Info "Creating launchers..."
$localLauncher = Write-LocalLauncher
$globalLauncher = Write-GlobalLauncher
Write-Ok "Local launcher:  $localLauncher"
Write-Ok "Global command:  $globalLauncher"

Write-Host ""
Write-Info "Verifying sparkc..."
try {
    $version = & $bun run "$ProjectRoot\src\dev-entry.ts" --version
    Write-Ok "sparkc is ready. Version: $version"
}
catch {
    Write-Warn "Version check failed, but installation finished."
    Write-Host "Try running: .\sparkc.cmd --version" -ForegroundColor Gray
}

Write-Host ""
Write-Ok "Installation complete."
Write-Host "Run now:        .\sparkc.cmd" -ForegroundColor White
Write-Host "New terminal:   sparkc" -ForegroundColor White

if ($PathChanged) {
    Write-Host ""
    Write-Warn "PATH was updated. Open a new terminal before using the global sparkc command."
}

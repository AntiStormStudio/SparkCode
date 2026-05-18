# Spark Code 安装脚本 (Windows PowerShell)
# 自动检查并安装 Bun，然后安装项目依赖。

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

Set-Location $ProjectRoot

Write-Host "=== Spark Code Windows 安装脚本 ===" -ForegroundColor Cyan
Write-Host "Platform: $env:OS" -ForegroundColor Gray
Write-Host "Project:  $ProjectRoot" -ForegroundColor Gray
Write-Host ""

# ---------- 检查/安装 Bun ----------
function Install-Bun {
    Write-Host "⚠️  未检测到 Bun，正在安装..." -ForegroundColor Yellow
    try {
        # 使用 Bun 官方安装脚本
        Invoke-Expression (Invoke-RestMethod -Uri "https://bun.sh/install.ps1")
    }
    catch {
        Write-Host "❌ Bun 自动安装失败。请手动安装：https://bun.sh" -ForegroundColor Red
        exit 1
    }

    # 刷新 PATH
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"

    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Write-Host "❌ Bun 安装后仍不可用。请检查 PATH 或手动安装。" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Bun 安装成功: $(bun --version)" -ForegroundColor Green
}

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCmd) {
    Write-Host "✅ 已安装 Bun $(bun --version)" -ForegroundColor Green
}
else {
    Install-Bun
}

# ---------- 安装依赖 ----------
Write-Host ""
Write-Host "📦 正在安装依赖 (bun install)..." -ForegroundColor Cyan

$lockFile = Join-Path $ProjectRoot "bun.lock"
if (-not (Test-Path $lockFile)) {
    Write-Host "⚠️  警告: 未找到 bun.lock，依赖版本可能不固定" -ForegroundColor Yellow
}

bun install
Write-Host "✅ 依赖安装完成" -ForegroundColor Green

# ---------- 验证安装 ----------
Write-Host ""
Write-Host "🧪 验证安装..." -ForegroundColor Cyan

try {
    $version = bun run .\src\dev-entry.ts --version 2>$null
    Write-Host "✅ 启动验证通过，版本: $version" -ForegroundColor Green
}
catch {
    Write-Host "⚠️  启动验证失败，但安装已完成。" -ForegroundColor Yellow
    Write-Host "   可以尝试手动运行: bun run .\src\dev-entry.ts --version" -ForegroundColor Gray
}

# ---------- 使用说明 ----------
Write-Host ""
Write-Host "=== 安装完成 ===" -ForegroundColor Green
Write-Host ""
Write-Host "Windows 运行方式:" -ForegroundColor Cyan
Write-Host "  bun run .\src\dev-entry.ts" -ForegroundColor White
Write-Host "  bun run .\src\dev-entry.ts --version" -ForegroundColor White
Write-Host ""
Write-Host "提示: Windows 不支持 shebang 脚本，请直接使用 bun run 启动。" -ForegroundColor Gray
Write-Host ""

#!/usr/bin/env bash
set -euo pipefail

# Spark Code 安装脚本 (macOS / Linux)
# 自动检查并安装 Bun，然后安装项目依赖。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "=== Spark Code 安装脚本 ==="
echo "Platform: $(uname -s) $(uname -m)"
echo "Project:  $PROJECT_ROOT"
echo ""

# ---------- 检查/安装 Bun ----------
install_bun() {
  echo "⚠️  未检测到 Bun，正在安装..."
  curl -fsSL https://bun.sh/install | bash

  # 尝试找到新安装的 bun
  if [[ -f "$HOME/.bun/bin/bun" ]]; then
    export PATH="$HOME/.bun/bin:$PATH"
  elif [[ -f "$HOME/.local/share/pnpm/bun" ]]; then
    export PATH="$HOME/.local/share/pnpm:$PATH"
  fi

  if ! command -v bun &> /dev/null; then
    echo "❌ Bun 安装失败。请手动安装：https://bun.sh"
    exit 1
  fi
  echo "✅ Bun 安装成功: $(bun --version)"
}

if command -v bun &> /dev/null; then
  echo "✅ 已安装 Bun $(bun --version)"
else
  install_bun
fi

# ---------- 安装依赖 ----------
echo ""
echo "📦 正在安装依赖 (bun install)..."
if [[ ! -f "bun.lock" && ! -f "bun 2.lock" ]]; then
  echo "⚠️  警告: 未找到 bun.lock，依赖版本可能不固定"
fi

bun install

echo "✅ 依赖安装完成"

# ---------- 设置可执行权限 ----------
echo ""
echo "🔧 设置可执行权限..."
chmod +x bin/sparkc 2>/dev/null || true

# ---------- 验证安装 ----------
echo ""
echo "🧪 验证安装..."
if ./bin/sparkc --version &> /dev/null; then
  echo "✅ sparkc 命令可用"
else
  echo "⚠️  sparkc 命令测试失败，但安装已完成。"
  echo "   可以尝试手动运行: bun run ./src/dev-entry.ts --version"
fi

# ---------- 创建快捷方式（可选） ----------
echo ""
read -r -p "是否创建全局 'sparkc' 命令链接? (y/N) " answer </dev/tty || true
if [[ "$answer" =~ ^[Yy]$ ]]; then
  LINK_DIR=""
  for d in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
    if echo "$PATH" | grep -q "$d"; then
      LINK_DIR="$d"
      break
    fi
  done

  if [[ -z "$LINK_DIR" ]]; then
    LINK_DIR="$HOME/.local/bin"
    mkdir -p "$LINK_DIR"
  fi

  if [[ -w "$LINK_DIR" ]]; then
    ln -sf "$PROJECT_ROOT/bin/sparkc" "$LINK_DIR/sparkc"
    echo "✅ 已创建链接: $LINK_DIR/sparkc"
    echo "   现在可以在任意目录运行 'sparkc'"
  else
    echo "⚠️  没有写入权限: $LINK_DIR"
    echo "   请手动创建链接: sudo ln -sf $PROJECT_ROOT/bin/sparkc /usr/local/bin/sparkc"
  fi
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "运行方式："
echo "  直接运行: $PROJECT_ROOT/bin/sparkc"
echo "  开发模式: bun run ./src/dev-entry.ts"
echo "  查看版本: $PROJECT_ROOT/bin/sparkc --version"
echo ""

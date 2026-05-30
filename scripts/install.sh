#!/usr/bin/env bash
set -euo pipefail

# Spark Code 安装脚本 (macOS / Linux)
# 自动检查并安装 Bun，然后安装项目依赖。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUN_VERSION="${BUN_VERSION:-1.3.5}"
CHINA_MODE=0
REGISTRY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --china)
      CHINA_MODE=1
      shift
      ;;
    --registry)
      REGISTRY="${2:-}"
      shift 2
      ;;
    --registry=*)
      REGISTRY="${1#*=}"
      shift
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

cd "$PROJECT_ROOT"

echo "=== Spark Code 安装脚本 ==="
echo "Platform: $(uname -s) $(uname -m)"
echo "Project:  $PROJECT_ROOT"
echo "Bun:      $BUN_VERSION"
echo ""

detect_bun_asset() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      echo "不支持的系统: $os" >&2
      return 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *)
      echo "不支持的 CPU 架构: $arch" >&2
      return 1
      ;;
  esac

  echo "bun-${os}-${arch}.zip"
}

download_bun_archive() {
  local asset="$1"
  local archive="$2"
  local urls=()

  if [[ "$CHINA_MODE" = "1" ]]; then
    urls+=("https://registry.npmmirror.com/-/binary/bun/bun-v${BUN_VERSION}/${asset}")
    urls+=("https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}")
  else
    urls+=("https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}")
    urls+=("https://registry.npmmirror.com/-/binary/bun/bun-v${BUN_VERSION}/${asset}")
  fi

  for url in "${urls[@]}"; do
    echo "下载 Bun: $url"
    if curl -fL --retry 2 --connect-timeout 15 --max-time 300 -o "$archive" "$url"; then
      return 0
    fi
    rm -f "$archive"
  done

  return 1
}

install_bun() {
  echo "⚠️  未检测到 Bun，正在安装..."

  if ! command -v unzip &> /dev/null; then
    echo "❌ 缺少 unzip，请先安装 unzip 后重试。"
    exit 1
  fi

  local asset archive extract_dir bun_file
  asset="$(detect_bun_asset)"
  archive="$(mktemp)"
  extract_dir="$(mktemp -d)"

  if ! download_bun_archive "$asset" "$archive"; then
    echo "❌ Bun 下载失败。请手动安装：https://bun.sh"
    rm -f "$archive"
    rm -rf "$extract_dir"
    exit 1
  fi

  unzip -q "$archive" -d "$extract_dir"
  bun_file="$(find "$extract_dir" -type f -name bun -print -quit)"
  if [[ -z "$bun_file" ]]; then
    echo "❌ Bun 压缩包中未找到可执行文件。"
    rm -f "$archive"
    rm -rf "$extract_dir"
    exit 1
  fi

  mkdir -p "$HOME/.bun/bin"
  cp "$bun_file" "$HOME/.bun/bin/bun"
  chmod +x "$HOME/.bun/bin/bun"
  export PATH="$HOME/.bun/bin:$PATH"

  rm -f "$archive"
  rm -rf "$extract_dir"

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

if [[ -z "$REGISTRY" && "$CHINA_MODE" = "1" ]]; then
  REGISTRY="https://registry.npmmirror.com"
fi

if [[ -n "$REGISTRY" ]]; then
  bun install --registry "$REGISTRY"
else
  bun install
fi

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

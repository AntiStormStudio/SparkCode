#!/usr/bin/env bash
set -euo pipefail

# Spark Code 打包脚本
# 生成一个不含 node_modules 的源码分发包，目标机器通过 install 脚本自动安装依赖。

to_posix_path() {
  local path="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$path"
  else
    printf '%s\n' "$path"
  fi
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    return 1
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(to_posix_path "$(dirname "$SCRIPT_DIR")")"

cd "$PROJECT_ROOT"

VERSION="$(bun -e "console.log(require('./package.json').version)" 2>/dev/null || node -p "require('./package.json').version" 2>/dev/null || echo '0.2.0')"
BUN_VERSION="$(bun -e "const pm=require('./package.json').packageManager||'bun@1.3.5'; console.log(pm.replace(/^bun@/, ''))" 2>/dev/null || echo '1.3.5')"
NAME="spark-code"
INCLUDE_WINDOWS_BUN="${INCLUDE_WINDOWS_BUN:-1}"
REQUIRE_WINDOWS_BUN="${REQUIRE_WINDOWS_BUN:-0}"
BUN_WINDOWS_SHA256="${BUN_WINDOWS_SHA256:-}"

if [ -z "$BUN_WINDOWS_SHA256" ] && [ "$BUN_VERSION" = "1.3.5" ]; then
  BUN_WINDOWS_SHA256="922cffdd5143cd118c6ccec6a61dfcf5d69e0068b048ea00f0a0615016530082"
fi

# 支持通过环境变量指定输出目录
DIST_DIR="$(to_posix_path "${DIST_DIR:-$PROJECT_ROOT/dist}")"
mkdir -p "$DIST_DIR"

echo "=== Spark Code Release Packager ==="
echo "Version: $VERSION"
echo "Bun:     $BUN_VERSION"
echo "Project: $PROJECT_ROOT"
echo "Output:  $DIST_DIR"
echo ""

download_windows_bun() {
  local package_root="$1"
  local runtime_dir="$package_root/runtime/win32-x64"
  local archive="$TMP_DIR/bun-windows-x64.zip"
  local extract_dir="$TMP_DIR/bun-windows-x64"
  local urls=(
    "https://registry.npmmirror.com/-/binary/bun/bun-v${BUN_VERSION}/bun-windows-x64.zip"
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip"
  )

  mkdir -p "$runtime_dir"

  for url in "${urls[@]}"; do
    echo "  下载 Windows Bun: $url"
    if ! curl -fL --retry 2 --connect-timeout 15 --max-time 300 -o "$archive" "$url"; then
      rm -f "$archive"
      continue
    fi

    if [ -n "$BUN_WINDOWS_SHA256" ]; then
      local actual_sha256
      if ! actual_sha256="$(sha256_file "$archive")"; then
        echo "  ⚠️  当前环境缺少 sha256 校验工具，无法校验 Bun 压缩包。"
      elif [ "$actual_sha256" != "$BUN_WINDOWS_SHA256" ]; then
        echo "  ⚠️  Bun 压缩包校验失败，跳过此下载源。"
        rm -f "$archive"
        continue
      fi
    fi

    if [ -s "$archive" ]; then
      break
    fi
    rm -f "$archive"
  done

  if [ ! -s "$archive" ]; then
    echo "  ⚠️  未能内置 Windows Bun，安装器会在用户机器上再尝试下载。"
    rmdir "$runtime_dir" 2>/dev/null || true
    if [ "$REQUIRE_WINDOWS_BUN" = "1" ]; then
      return 1
    fi
    return 0
  fi

  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"
  unzip -q "$archive" -d "$extract_dir"

  local bun_exe
  bun_exe="$(find "$extract_dir" -name 'bun.exe' -type f -print -quit)"
  if [ -z "$bun_exe" ]; then
    echo "  ⚠️  Bun 压缩包中未找到 bun.exe，跳过内置运行时。"
    rm -rf "$runtime_dir"
    if [ "$REQUIRE_WINDOWS_BUN" = "1" ]; then
      return 1
    fi
    return 0
  fi

  cp "$bun_exe" "$runtime_dir/bun.exe"
  echo "  ✅ 已内置 Windows Bun runtime/win32-x64/bun.exe"
}

# ---------- macOS / Linux 包 ----------
TARBALL="$DIST_DIR/${NAME}-${VERSION}.tar.gz"
TAR_TMP="$DIST_DIR/${NAME}-${VERSION}.tmp.tar"
echo "📦 打包 macOS/Linux 分发包..."

# 先创建未压缩的 tar（方便后续追加可选文件）
tar cf "$TAR_TMP" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='.vscode' \
  --exclude='.idea' \
  --exclude='*.swp' \
  --exclude='image-processor.node' \
  -C "$PROJECT_ROOT" \
  src/ vendor/ shims/ bin/ scripts/ \
  package.json tsconfig.json bun.lock

# 追加可选文件（如果不存在则忽略）
for f in README.md LICENSE.md SPARK.md AGENTS.md install.cmd install-cn.cmd sparkc.cmd; do
  if [ -f "$PROJECT_ROOT/$f" ]; then
    tar rf "$TAR_TMP" -C "$PROJECT_ROOT" "$f"
  fi
done

# gzip 压缩并清理临时文件
gzip -c "$TAR_TMP" > "$TARBALL"
rm -f "$TAR_TMP"

TARBALL_SIZE="$(du -sh "$TARBALL" | cut -f1)"
echo "✅ macOS/Linux: $TARBALL ($TARBALL_SIZE)"

# ---------- Windows 包 ----------
ZIPFILE="$DIST_DIR/${NAME}-${VERSION}.zip"
echo "📦 打包 Windows 分发包..."

# 先创建临时目录，排除不需要的文件
TMP_DIR="$(mktemp -d)"
mkdir -p "$TMP_DIR/$NAME-$VERSION"

cp -R src vendor shims bin scripts "$TMP_DIR/$NAME-$VERSION/"
for f in package.json tsconfig.json bun.lock README.md LICENSE.md SPARK.md AGENTS.md install.cmd install-cn.cmd sparkc.cmd; do
  [ -f "$f" ] && cp "$f" "$TMP_DIR/$NAME-$VERSION/"
done

if [ "$INCLUDE_WINDOWS_BUN" = "1" ]; then
  download_windows_bun "$TMP_DIR/$NAME-$VERSION"
fi

# 清理 Windows 包中不需要的文件
rm -f "$TMP_DIR/$NAME-$VERSION/image-processor.node" 2>/dev/null || true
rm -rf "$TMP_DIR/$NAME-$VERSION/.DS_Store" 2>/dev/null || true

(cd "$TMP_DIR" && zip -rq "$ZIPFILE" "${NAME}-${VERSION}")
rm -rf "$TMP_DIR"

ZIP_SIZE="$(du -sh "$ZIPFILE" | cut -f1)"
echo "✅ Windows: $ZIPFILE ($ZIP_SIZE)"

echo ""
echo "=== 打包完成 ==="
echo ""
echo "macOS/Linux 使用方法："
echo "  tar xzf $TARBALL"
echo "  cd ${NAME}-${VERSION}"
echo "  ./scripts/install.sh"
echo ""
echo "Windows 使用方法："
echo "  解压 ${NAME}-${VERSION}.zip"
echo "  cd ${NAME}-${VERSION}"
echo "  双击 install.cmd"
echo "  或运行 .\\install.cmd"
echo "  国内网络优先双击 install-cn.cmd"
echo ""

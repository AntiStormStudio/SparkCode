#!/usr/bin/env bash
set -euo pipefail

# Spark Code 打包脚本
# 生成一个不含 node_modules 的源码分发包，目标机器通过 install 脚本自动安装依赖。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '0.1.1')"
NAME="spark-code"

# 支持通过环境变量指定输出目录
DIST_DIR="${DIST_DIR:-$PROJECT_ROOT/dist}"
mkdir -p "$DIST_DIR"

echo "=== Spark Code Release Packager ==="
echo "Version: $VERSION"
echo "Project: $PROJECT_ROOT"
echo "Output:  $DIST_DIR"
echo ""

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
  --exclude='TextInputPill.js' \
  --exclude='image-processor.node' \
  -C "$PROJECT_ROOT" \
  src/ vendor/ shims/ bin/ scripts/ \
  package.json tsconfig.json bun.lock

# 追加可选文件（如果不存在则忽略）
for f in README.md LICENSE.md SPARK.md AGENTS.md; do
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
for f in package.json tsconfig.json bun.lock README.md LICENSE.md SPARK.md AGENTS.md; do
  [ -f "$f" ] && cp "$f" "$TMP_DIR/$NAME-$VERSION/"
done

# 清理 Windows 包中不需要的文件
rm -rf "$TMP_DIR/$NAME-$VERSION/src/components/PromptInput/TextInputPill.js" 2>/dev/null || true
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
echo "  .\\scripts\\install.ps1"
echo ""

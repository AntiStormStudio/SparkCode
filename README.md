# SPARK Code

> 一个基于终端的 AI 编程助手，支持多模型、自定义后端、模型别名映射和跨平台分发。

## 功能特性

- **多模型支持** — 可切换 Claude、DeepSeek、GLM 等多种模型
- **自定义后端** — 通过 base URL + token 登录任意兼容 OpenAI API 的后端
- **模型别名映射 (`/model-reflex`)** — 为长模型名创建短别名，如 `ds` → `deepseek-chat`
- **图片粘贴智能拦截** — 自动检测不支持图片的模型（deepseek/glm）并提示用户
- **跨平台打包** — 提供 macOS / Linux / Windows 分发包，目标机器一键安装
- **配置隔离** — 使用 `~/.sparkc/` 目录，不与原版 Claude Code 冲突

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/AntiStormStudio/SparkCode.git
cd SparkCode

# 安装依赖（需要 Bun ≥ 1.3.5）
bun install

# 启动 CLI
bun run dev

# 或查看版本
bun run version
```

## 安装到别的设备

下载 Release 中的分发包，解压后运行安装脚本：

**macOS / Linux：**
```bash
tar xzf spark-code-0.1.1.tar.gz
cd spark-code-0.1.1
./scripts/install.sh
```

**Windows：**
```powershell
# 解压 spark-code-0.1.1.zip 后
cd spark-code-0.1.1
.\scripts\install.ps1
```

安装脚本会自动检查并安装 Bun，然后运行 `bun install` 完成环境配置。

## 主要命令

| 命令 | 说明 |
|------|------|
| `/login` | 使用 base URL + token 登录 |
| `/model` | 切换当前使用的模型 |
| `/model-list` | 查看后端支持的模型列表 |
| `/model-reflex` | 管理模型别名映射 |
| `/config-server` | 配置后端服务器地址 |
| `/status` | 查看当前状态 |

## 打包发布

```bash
# 生成分发包到 dist/
bun run package

# 或手动运行
bash scripts/package-release.sh
```

## 项目结构

```
src/                    # 核心源码
├── commands/           # 斜杠命令
├── services/           # API / MCP / 终端服务
├── components/         # 终端 UI 组件（React + Ink）
├── hooks/              # 自定义 Hooks
├── utils/              # 工具函数
└── ...
scripts/                # 打包和安装脚本
.github/workflows/      # CI 配置
shims/                  # 兼容模块
vendor/                 # 原生绑定源码
```

## 环境要求

- [Bun](https://bun.sh) ≥ 1.3.5
- Node.js ≥ 24.0.0

## 声明

本项目基于公开 npm 包的 source map 进行源码还原与重构，仅供技术研究与学习使用。

# SPARK.md

This file provides guidance to Spark Code (spark-ai.top/code) when working with code in this repository.

## 仓库说明

这是 SPARK-Code（原 Claude Code）从 npm 包 source map 还原的源码树，**可本地运行**。项目约 2000 个 TypeScript 源文件、51 万行代码。源码版权归 Anthropic 所有，仅供研究学习。

## 常用命令

```bash
bun install       # 安装依赖及 shims 包
bun run dev        # 启动 CLI（入口 src/dev-entry.ts）
bun run start      # 等同于 dev
bun run version    # 验证版本输出
```

无内置 lint / test 脚本。修改后通过 `bun run dev` 手动验证相关路径。TypeScript 编译由 `tsc --noEmit` 检查（`tsconfig.json` 配置：ESNext 模块、react-jsx JSX、baseUrl "."、paths "src/*"）。

## 代码架构

### 入口链路

```
bin/sparkc (shell bootstrap) → bun run ./src/dev-entry.ts → src/main.tsx (TUI主循环)
                                                            → src/commands.ts (CLI commander注册)
```

### 核心分层

| 层 | 职责 |
|---|---|
| `src/main.tsx` | TUI 终端 UI 主渲染循环（React + Ink） |
| `src/commands.ts` | Commander.js CLI 命令注册中心 |
| `src/tools/` | 工具执行器（Bash/FileEdit/Agent/MCP/Computer Use 等 ~53 个） |
| `src/services/` | 后端服务：API 调用、MCP 客户端、analytics、记忆整合(autoDream) |
| `src/components/` | TUI 组件（~148 个 React 组件） |
| `src/hooks/` | 自定义 Hooks（~87 个） |
| `src/context.ts` | React Context 全局状态注入 |
| `src/state/` | 本地状态管理 |
| `src/schemas/` | Zod 数据校验模式定义 |
| `src/query.ts` / `QueryEngine.ts` | 语义搜索引擎（Fuse.js 模糊匹配） |

### 关键子系统

- **`src/buddy/`** — AI 宠物系统，feature-gated (`BUDDY`)
- **`src/assistant/` + `src/proactive/`** — KAIROS 持久助手模式，含后台任务、自动做梦(intern integration)、锁机制
- **`src/coordinator/`** — 多 Agent 编排：Coordinator 派活给 Worker 子进程
- **`src/bridge/`** (33 文件) — WebSocket 远程控制桥接
- **`src/vim/`** — Vim 键盘快捷键引擎
- **`src/voice/`** — 语音交互
- **`src/screens/`** — 全屏界面（登录、配置向导等）
- **`src/entrypoints/`** — 不同启动模式的入口分发
- **`src/bootstrap/`** — 运行时初始化
- **`src/server/`** — 内置 HTTP/WebSocket 服务器
- **`src/remote/`** — 远程会话管理、teleport
- **`src/migrations/`** — 配置版本迁移
- **`src/plugins/`** — 插件系统
- **`src/skills/`** — Skill 指令处理器

### 特征门控体系（三层）

1. **编译时** — `feature('FLAG')` 函数，约 50 个开关决定代码是否包含
2. **用户类型** — `USER_TYPE === 'ant'` 内部版 vs `'external'` 外部版，600+ 处检查
3. **远程 A/B** — GrowthBook SDK（`@growthbook/growthbook`），20 分钟（内部）/ 6 小时（外部）刷新

门控逻辑通常集中在 `src/utils/featureFlags.ts` 附近及环境变量中。

### 辅助目录

- `shims/` — 原生 N-API 模块的 JS shim 替代（color-diff-napi、modifiers-napi 等）
- `vendor/` — 原生二进制绑定（ripgrep 等）

### 编码约定

- TypeScript ESM，无分号，单引号
- camelCase 变量/函数，PascalCase 组件/管理类
- 命令文件夹用 kebab-case（如 `src/commands/install-slack-app/`）
- React 组件位于 `src/components/` 或内联在 `.tsx` 命令文件中

# 项目结构地图（精简版）

## 1) 启动链路

1. `package.json` -> `bun run dev`
2. `src/dev-entry.ts`
   - 先扫描 `src/` 与 `vendor/` 的相对导入缺失
   - 无缺失才继续进入真实入口
3. `src/entrypoints/cli.tsx`
   - 处理 fast-path（`--version`、`daemon`、`remote-control` 等）
   - 最后动态导入 `src/main.tsx`
4. `src/main.tsx`
   - 完成初始化、配置加载、命令/工具装配
   - 启动 REPL 与主循环

## 2) 目录分层

- `src/commands/`: Slash 命令实现与命令定义
- `src/tools/`: 模型可调用工具（文件、终端、搜索、MCP、任务等）
- `src/services/`: 业务服务（MCP、LSP、analytics、API、memory 等）
- `src/components/`: TUI 组件（Ink/React）
- `src/entrypoints/`: CLI/MCP/SDK 等入口
- `src/utils/`: 通用基础能力（配置、权限、会话、模型、git、插件等）
- `src/state/`: 应用状态与状态管理

## 3) 核心调度关系

- 命令注册中心：`src/commands.ts`
- 工具注册中心：`src/tools.ts`
- 会话执行引擎：`src/QueryEngine.ts`

关系：
- `main.tsx` -> `getCommands()` + `getTools()` -> `launchRepl()`
- `QueryEngine` 负责消息流、工具调用、权限与 usage 累计

## 4) 这次精简掉的命令（按需求）

已从 `src/commands.ts` 的命令注册入口移除以下能力：

- 内部命令：
  - `/teleport`
  - `/bughunter`
  - `/mock-limits`
  - `/ctx_viz`
  - `/break-cache`
  - `/ant-trace`
  - `/good-claude`
  - `/agents-platform`
  - `/autofix-pr`
  - `/debug-tool-call`
  - `/reset-limits`
- Feature-gated 命令：
  - `/buddy`
  - `/proactive`
  - `/assistant`
  - `/brief`
  - `/bridge`
  - `/voice`
  - `/ultraplan`
  - `/fork`
  - `/peers`
  - `/workflows`
  - `/torch`
  - `/force-snip`

附加调整：
- 同时关闭了 workflow 动态命令加载入口（`getWorkflowCommands`），避免 `/workflows` 相关能力通过动态路径残留。

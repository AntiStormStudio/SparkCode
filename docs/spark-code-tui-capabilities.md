# Spark Code TUI 能力盘点

范围：只看原 TUI 运行时能力，不看 GUI 后端暴露接口。

## 运行时命令

当前 `getCommands(process.cwd())` 返回 112 条，其中本机 Skills 因 `.codex` 和 `.agents` 双来源重复；去重后主要是 29 个 Skills、49 个本地 TUI 命令、6 个内置 prompt 命令。

可用本地 TUI 命令：
- 会话：`clear/reset/new`、`compact`、`resume/continue`、`rename`、`branch/fork`、`rewind/checkpoint`、`export`
- 输入/上下文：`add-dir`、`context`、`copy`、`btw`
- 设置：`config/settings`、`theme`、`color`、`vim`、`terminal-setup`、`sandbox`
- 模型：`model`、`default-model`、`model-list`、`model-reflex`
- 权限：`permissions/allowed-tools`、`plan`
- MCP/Skills/插件/Agent：`mcp`、`skills`、`plugin/plugins/marketplace`、`reload-plugins`、`agents`
- 诊断/状态：`doctor`、`status`、`stats`、`cost`
- 账号/连接：`login`、`logout`、`remote`、`ide`、`mobile`
- 任务：`tasks/bashes`
- 代码 prompt：`init`、`review`、`security-review`、`pr-comments`、`insights`、`statusline`
- 其他：`help`、`openterminal/open-terminal`、`release-notes`、`stickers`

源码存在但当前运行时未启用的代表项：`files`、`usage`、`feedback`、`keybindings`、`fast`、`extra-usage`、`rate-limit-options`、`session`、`remote-env`、`privacy-settings`。后续 GUI 不应直接显示这些，除非运行时 `getCommands()` 返回。

## 工具池

当前 `getTools(getEmptyToolPermissionContext())` 启用 19 个工具：
- 代理/任务：`Agent`、`TaskOutput`、`TaskStop`
- Shell/文件：`Bash`、`Read`、`Edit`、`Write`、`Glob`、`Grep`、`NotebookEdit`
- 网络：`WebFetch`、`WebSearch`
- 流程：`TodoWrite`、`AskUserQuestion`、`Skill`、`EnterPlanMode`、`ExitPlanMode`
- 工作树：`EnterWorktree`、`ExitWorktree`

源码里还有 MCP resource tools、SendMessage、LSP、WebBrowser、Workflow、Monitor、cron、PowerShell 等 feature-gated 工具。真实工具池入口是 `assembleToolPool(permissionContext, mcpTools)`，GUI 后续应该同步这个结果。

## TUI 面板能力

输入框：
- slash/typeahead、命令提示、历史上下翻、历史搜索、全局搜索、快速打开文件
- 队列预览、`now/next/later` 优先级、可编辑队列消息拉回输入框
- 图片粘贴、长文本粘贴引用、外部编辑器、stash 草稿、Vim 模式
- 模型选择、Thinking 开关、权限模式循环、Fast/任务/Bridge 状态页脚

设置：
- 状态、配置、用量三类主面板
- 配置项包括主题、模型、输出风格、语言、默认权限模式、Thinking、提示词建议、自动压缩、检查点、Diff 工具、IDE 自动连接/安装、远程控制启动项、通知、默认视图等

权限：
- 运行时权限弹窗覆盖 Bash、文件读写、Notebook、WebFetch、Skill、Plan、AskUserQuestion 等
- 权限规则面板支持 allow/ask/deny、最近拒绝、workspace 目录添加/移除、规则保存到 user/project/local/session

MCP/Skills/Agents：
- MCP 支持 project/local/user/enterprise/dynamic 分组，stdio/http/sse/claudeai-proxy，工具列表、工具详情、认证状态
- Skills 按 project/user/policy/plugin/mcp 分组展示，包含 token 估算
- Agents 支持按来源分组、查看详情、新建、编辑、删除，详情含工具、模型、权限模式、记忆、hooks、skills、颜色、系统提示

对话/任务/Diff：
- 消息支持复制、编辑用户消息、复制工具主输入、展开/折叠工具组
- Transcript 模式、消息选择器、恢复对话/代码、从指定消息总结
- Diff 面板支持未提交变更和每轮变更、文件列表、详情、二进制/大文件/未跟踪状态
- 任务面板支持 bash、remote agent、local agent、teammate、workflow、MCP monitor、dream 的查看、停止、前台切换

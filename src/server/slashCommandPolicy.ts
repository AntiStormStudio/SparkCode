export const SETTINGS_COMMAND_NAMES = new Set([
  'advisor',
  'agents',
  'chrome',
  'color',
  'config',
  'default-model',
  'effort',
  'extra-usage',
  'fast',
  'hooks',
  'ide',
  'keybindings',
  'login',
  'logout',
  'mcp',
  'model',
  'model-list',
  'model-reflex',
  'android',
  'ios',
  'mobile',
  'output-style',
  'permissions',
  'plugin',
  'plugins',
  'privacy-settings',
  'rate-limit-options',
  'remote',
  'remote-env',
  'marketplace',
  'reload-plugins',
  'sandbox',
  'skills',
  'statusline',
  'terminal-setup',
  'theme',
  'vim',
  'update-config',
])

export const AUTOMATION_COMMAND_NAMES = new Set([
  'batch',
  'bashes',
  'install-github-app',
  'install-slack-app',
  'tasks',
  'workflow',
  'workflows',
])

export const COMMAND_CATEGORY: Record<string, string> = {
  clear: '会话',
  compact: '会话',
  context: '会话',
  copy: '会话',
  export: '会话',
  help: '会话',
  rename: '会话',
  resume: '会话',
  session: '会话',
  tag: '会话',
  'add-dir': '上下文',
  files: '本地',
  init: '本地',
  memory: '本地',
  openterminal: '本地',
  branch: 'Git',
  commit: 'Git',
  'commit-push-pr': 'Git',
  diff: 'Git',
  'pr-comments': 'Git',
  rewind: 'Git',
  plan: 'Review',
  review: 'Review',
  'security-review': 'Review',
  ultrareview: 'Review',
  cost: '统计',
  insights: '统计',
  stats: '统计',
  usage: '统计',
  doctor: '支持',
  feedback: '支持',
  'install-github-app': '支持',
  'install-slack-app': '支持',
  'release-notes': '支持',
  upgrade: '支持',
}

export const GUI_SLASH_COMMANDS = [
  ['add-dir', '上下文', '添加路径上下文', true],
  ['branch', 'Git', '从当前会话节点创建分支', true],
  ['btw', '其他', '在不打断主会话的情况下快速提一个旁支问题', true],
  ['clear', '会话', '清空会话历史并释放上下文', false],
  ['compact', '会话', '清空会话历史但保留上下文摘要。可选：/compact [摘要指令]', true],
  ['context', '会话', '显示当前上下文使用情况', false],
  ['copy', '会话', '复制 Spark 最近一条回复到剪贴板（或用 /copy N 复制倒数第 N 条）', false],
  ['cost', '统计', '显示当前会话总费用和时长', false],
  ['diff', 'Git', '查看未提交变更与每轮差异', false],
  ['doctor', '支持', '诊断并验证 Spark Code 安装状态', false],
  ['exit', '其他', '退出 Spark Code', false],
  ['export', '会话', '导出当前会话到文件或剪贴板', true],
  ['help', '会话', '显示帮助与可用命令', false],
  ['init', '本地', '初始化新的 SPARK.md 代码库文档', true],
  ['insights', '统计', '生成 Spark Code 会话分析报告', true],
  ['memory', '本地', '编辑 Spark 记忆文件', false],
  ['openterminal', '本地', '启动网页可访问的 OpenTerminal 本地终端工具', true],
  ['plan', 'Review', '启用计划模式或查看当前会话计划', true],
  ['pr-comments', 'Git', '获取 GitHub 拉取请求评论', true],
  ['release-notes', '支持', '查看发行说明', false],
  ['rename', '会话', '重命名当前会话', true],
  ['resume', '会话', '恢复之前的会话', true],
  ['review', 'Review', '审查拉取请求', true],
  ['rewind', 'Git', '将代码和/或对话恢复到之前的时间点', false],
  ['security-review', 'Review', '对当前分支待提交改动执行安全审查', true],
  ['stats', '统计', '显示 Spark Code 使用统计与活动', false],
  ['status', '其他', '显示 Spark Code 状态', false],
  ['stickers', '其他', '订购 Spark Code 贴纸', false],
] as const

export const GUI_HANDLED_COMMAND_NAMES = new Set([
  'add-dir',
  'branch',
  'btw',
  'clear',
  'compact',
  'context',
  'copy',
  'cost',
  'diff',
  'doctor',
  'exit',
  'export',
  'help',
  'memory',
  'openterminal',
  'open-terminal',
  'plan',
  'release-notes',
  'rename',
  'resume',
  'review',
  'rewind',
  'security-review',
  'stats',
  'status',
  'stickers',
])

export const GUI_MODEL_OPTIONS = [
  ['default', '默认（推荐）', '使用当前默认模型'],
  ['sonnet', 'Sonnet', 'Sonnet 4.6 · 适合日常编码任务'],
  ['sonnet[1m]', 'Sonnet（1M 上下文）', 'Sonnet 4.6 · 适合长会话'],
  ['opus', 'Opus', 'Opus 4.6 · 适合复杂任务'],
  ['opus[1m]', 'Opus（1M 上下文）', 'Opus 4.6 · 适合大型代码库长会话'],
  ['haiku', 'Haiku', 'Haiku 4.5 · 适合快速回答'],
  ['opusplan', 'Opus 计划模式', '计划用 Opus，执行用 Sonnet'],
  ['best', 'Best', '自动选择当前最佳模型'],
] as const

export function isSettingsSlashCommand(name: string): boolean {
  return SETTINGS_COMMAND_NAMES.has(name.trim().toLowerCase())
}

export function isAutomationSlashCommand(name: string): boolean {
  return AUTOMATION_COMMAND_NAMES.has(name.trim().toLowerCase())
}

export function isHiddenFromGuiSlashList(command: {
  name: string
  description?: string
  category?: string
  loaded_from?: string
  source?: string
}): boolean {
  if (command.category === 'Plugin') return true
  if (command.source === 'plugin') return true
  if (command.loaded_from === 'plugin') return true
  if (isSettingsSlashCommand(command.name)) return true
  if (isAutomationSlashCommand(command.name)) return true

  const haystack = `${command.name}\n${command.description ?? ''}\n${command.category ?? ''}`.toLowerCase()
  return (
    haystack.includes('自动化') ||
    haystack.includes('工作流') ||
    haystack.includes('automation') ||
    haystack.includes('workflow')
  )
}

import {
  findCommand,
  formatDescriptionWithSource,
  getCommandName,
  getCommands,
  type Command,
} from '../commands.js'
import agentsPlatformCommand from '../commands/agents-platform/index.js'
import { contextNonInteractive } from '../commands/context/index.js'
import costCommand from '../commands/cost/index.js'
import { extraUsageNonInteractive } from '../commands/extra-usage/index.js'
import filesCommand from '../commands/files/index.js'
import modelListCommand from '../commands/model-list/index.js'
import modelReflexCommand from '../commands/model-reflex/index.js'
import openTerminalCommand from '../commands/openterminal/index.js'
import releaseNotesCommand from '../commands/release-notes/index.js'
import stickersCommand from '../commands/stickers/index.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import { getDoctorDiagnostic, type DiagnosticInfo } from '../utils/doctorDiagnostic.js'
import { aggregateClaudeCodeStatsForRange, type ClaudeCodeStats } from '../utils/stats.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  clearConfiguredAndroidAuth,
} from '../utils/auth.js'
import { getAuthHeaders, getUserAgent } from '../utils/http.js'
import { getGitState } from '../utils/git.js'
import type { ServerConfig } from './types.js'
import type { ServerLogger } from './serverLog.js'
import type { ImageAttachment, SessionManager } from './sessionManager.js'
import { dedupeByName, loadServerMcpRuntime } from './mcpRuntime.js'
import { assembleToolPool } from '../tools.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
  type ToolUseContext,
  type Tools,
} from '../Tool.js'
import {
  getIsInteractive,
  setIsInteractive,
  switchSession,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import { asSessionId } from '../types/ids.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js'
import {
  COMMAND_CATEGORY,
  GUI_HANDLED_COMMAND_NAMES,
  GUI_SLASH_COMMANDS,
  isHiddenFromGuiSlashList,
} from './slashCommandPolicy.js'
import {
  listPendingPermissions,
  respondToPermissionRequest,
  type GuiPermissionDecision,
} from './permissionBroker.js'
import { expandSlashPromptForServer } from './slashPromptExpander.js'

type ServerHandle = {
  port?: number
  stop: (force?: boolean) => void
}

type GuiSlashCommand = {
  name: string
  description: string
  aliases: string[]
  category: string
  accepts_args: boolean
  type?: string
  source?: string
  loaded_from?: string
  argument_hint?: string
}

type GuiToolEntry = {
  name: string
  description: string
  source: string
  category: string
  read_only: boolean | null
  enabled: boolean
  mcp_server: string | null
  mcp_tool: string | null
  input_schema: unknown | null
  should_defer: boolean
}

type FeedbackMessage = {
  role?: string
  content?: string
  created_at?: number
}

const GUI_LOCAL_COMMANDS: Command[] = [
  agentsPlatformCommand,
  contextNonInteractive,
  costCommand,
  extraUsageNonInteractive,
  filesCommand,
  modelListCommand,
  modelReflexCommand,
  openTerminalCommand,
  releaseNotesCommand,
  stickersCommand,
]

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  }
}

function readBearer(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

function isAuthorized(req: Request, config: ServerConfig): boolean {
  if (!config.authToken) return true
  return readBearer(req) === config.authToken
}

function wsUrl(req: Request, sessionId: string): string {
  const url = new URL(req.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/sessions/${sessionId}/ws`
  url.search = ''
  return url.toString()
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) return {}
  const value = await req.json().catch(() => ({}))
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function feedbackMessagesFromValue(value: unknown): FeedbackMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const role = stringValue(record.role)
    const content = stringValue(record.content)
    if (!role || !content) return []
    return [{
      role,
      content: content.slice(0, 8_000),
      created_at: typeof record.created_at === 'number' ? record.created_at : undefined,
    }]
  }).slice(-20)
}

function redactFeedbackText(value: string): string {
  return value
    .replace(/(sk-ant-?[A-Za-z0-9_-]{10,})/g, '[REDACTED_API_KEY]')
    .replace(/(AKIA[A-Z0-9]{16})/g, '[REDACTED_AWS_KEY]')
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?(bearer\s+)?)[^"',\s)}\]]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/((API[-_]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED]')
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return undefined
}

function permissionDecisionValue(value: unknown): GuiPermissionDecision | null {
  if (value === 'allow_once' || value === 'allow_session' || value === 'deny') {
    return value
  }
  return null
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>(resolve => {
    timeout = setTimeout(() => resolve(fallback), timeoutMs)
  })
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      timeoutPromise,
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function fallbackGuiSlashCommands(): GuiSlashCommand[] {
  return GUI_SLASH_COMMANDS.map(([name, category, description, acceptsArgs]) => ({
    name,
    description,
    aliases: {
      branch: ['fork'],
      exit: ['quit'],
      mobile: ['ios', 'android'],
      openterminal: ['open-terminal'],
      permissions: ['allowed-tools'],
      resume: ['continue'],
      rewind: ['checkpoint'],
      tasks: ['bashes'],
    }[name] ?? [],
    category,
    accepts_args: acceptsArgs,
    type: 'gui',
    source: 'builtin',
    loaded_from: 'gui',
    argument_hint: '',
  }))
}

function imageAttachmentsFromValue(value: unknown): ImageAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const data = stringValue(record.data)
    if (!data) return []
    return [{
      id: stringValue(record.id),
      name: stringValue(record.name),
      media_type: stringValue(record.media_type) ?? stringValue(record.mediaType) ?? 'image/png',
      data,
    }]
  })
}

function sseFrame(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

function streamPromptResponse(input: {
  sessionManager: SessionManager
  sessionId: string
  prompt: string
  cwd: string
  model?: string
  permissionMode?: string
  resume: boolean
  images: ImageAttachment[]
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => controller.enqueue(sseFrame(data))
      void (async () => {
        try {
          send({ type: 'status', status: 'thinking' })
          const content = await input.sessionManager.runPrompt(
            input.sessionId,
            input.prompt,
            await validatedModelValue(input.model),
            input.permissionMode,
            input.images,
            event => send({ type: 'event', event }),
          )
          send({
            type: 'result',
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content,
          })
        } catch (error) {
          send({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          controller.close()
        }
      })()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...corsHeaders(),
    },
  })
}

function promptTextFromValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'text' in item) {
          return typeof item.text === 'string' ? item.text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value && typeof value === 'object' && 'text' in value) {
    return typeof value.text === 'string' ? value.text : ''
  }
  return ''
}

async function loadSlashCommands(cwd: string): Promise<GuiSlashCommand[]> {
  const [baseCommands, mcpRuntime] = await Promise.all([
    withTimeout(
      getCommands(cwd),
      2_500,
      [] as Awaited<ReturnType<typeof getCommands>>,
    ),
    loadServerMcpRuntime({ timeoutMs: 2_500 }).catch(() => ({
      clients: [],
      tools: [],
      commands: [],
      resources: {},
    })),
  ])
  const commands = dedupeByName([
    ...baseCommands,
    ...mcpRuntime.commands,
  ])
  const dynamicCommands = dedupeByName(commands
    .filter(command => command.userInvocable !== false)
    .filter(command => !command.isHidden)
    .filter(command => {
      const name = getCommandName(command)
      if (GUI_HANDLED_COMMAND_NAMES.has(name)) return true
      if (command.type === 'prompt') return command.disableNonInteractive !== true
      if (command.type === 'local') return command.supportsNonInteractive === true
      return false
    })
    .map(command => {
      const name = getCommandName(command)
      const source = 'source' in command ? command.source : 'builtin'
      const guiOverride = GUI_SLASH_COMMANDS.find(([commandName]) => commandName === name)
      return {
        name,
        description: guiOverride?.[2] ?? formatDescriptionWithSource(command),
        aliases: command.aliases ?? [],
        category: guiOverride?.[1] ?? COMMAND_CATEGORY[name] ?? (
          command.loadedFrom === 'skills' || command.loadedFrom === 'bundled'
            ? 'Skill'
            : command.loadedFrom === 'mcp' || source === 'mcp'
              ? 'MCP'
            : source === 'plugin'
              ? 'Plugin'
              : '其他'
        ),
        accepts_args: guiOverride?.[3] ?? Boolean(command.argumentHint || command.type === 'prompt'),
        type: command.type,
        source,
        loaded_from: command.loadedFrom,
        argument_hint: command.argumentHint ?? '',
      }
    })
    .filter(command => !isHiddenFromGuiSlashList(command))
    .sort((a, b) => a.name.localeCompare(b.name)))

  return dynamicCommands
}

async function slashCommands(cwd: string): Promise<GuiSlashCommand[]> {
  return loadSlashCommands(cwd)
}

async function expandedPromptText(input: {
  cwd: string
  permissionMode?: string
  prompt: string
  sessionId: string
}): Promise<string> {
  const expanded = await withTimeout(
    expandSlashPromptForServer({
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      prompt: input.prompt,
      sessionId: input.sessionId,
    }),
    8_000,
    {
      blocked: true as const,
      message: '这个 / 命令展开超过 8 秒，已停止执行；请检查 GitHub CLI、Git 状态或网络后重试。',
    },
  ).catch(() => null)
  if (!expanded) return input.prompt
  if (expanded.blocked) return expanded.message
  return expanded.prompt || input.prompt
}

function permissionModeFromValue(value: unknown): ToolPermissionContext['mode'] {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized === 'auto-review' || normalized === 'acceptEdits' || normalized === 'auto') {
    return 'acceptEdits'
  }
  if (normalized === 'full' || normalized === 'bypassPermissions' || normalized === 'dangerously-skip-permissions') {
    return 'bypassPermissions'
  }
  if (normalized === 'dontAsk' || normalized === 'plan') return normalized
  return 'default'
}

function toolPermissionContext(mode: ToolPermissionContext['mode']): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    mode,
    isBypassPermissionsModeAvailable: mode === 'bypassPermissions',
  }
}

function toolSource(tool: Tool): string {
  if (tool.mcpInfo || tool.isMcp) return 'mcp'
  if (tool.isLsp) return 'lsp'
  return 'builtin'
}

function toolCategory(tool: Tool): string {
  if (tool.mcpInfo || tool.isMcp) return 'MCP'
  if (tool.isLsp) return 'LSP'
  if (['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit'].includes(tool.name)) return '文件'
  if (['Bash', 'PowerShell', 'TerminalCapture'].includes(tool.name)) return 'Shell'
  if (['WebFetch', 'WebSearch', 'WebBrowser'].includes(tool.name)) return '网络'
  if (['Agent', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'].includes(tool.name)) return '任务'
  if (['EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'TodoWrite', 'AskUserQuestion', 'Skill'].includes(tool.name)) return '流程'
  return '其他'
}

function fallbackToolDescription(tool: Tool): string {
  const descriptions: Record<string, string> = {
    Agent: '启动子代理执行复杂任务',
    AskUserQuestion: '向用户提问并收集选择',
    Bash: '运行 shell 命令',
    Edit: '编辑本地文件',
    EnterPlanMode: '进入计划模式',
    EnterWorktree: '创建并进入隔离工作树',
    ExitPlanMode: '退出计划模式',
    ExitWorktree: '退出工作树并恢复原工作目录',
    Glob: '按文件名模式查找文件',
    Grep: '在代码库中搜索文本或正则',
    NotebookEdit: '编辑 Jupyter notebook 单元格',
    Read: '读取本地文件',
    Skill: '执行已安装的 Skill',
    TaskOutput: '读取后台任务输出',
    TaskStop: '停止后台任务',
    TodoWrite: '更新当前会话待办列表',
    WebFetch: '读取网页内容',
    WebSearch: '搜索网页内容',
    Write: '写入本地文件',
  }
  return tool.searchHint ?? descriptions[tool.name] ?? ''
}

async function toolDescription(
  tool: Tool,
  tools: Tools,
  permissionContext: ToolPermissionContext,
): Promise<string> {
  try {
    const fallback = fallbackToolDescription(tool)
    const description = await withTimeout(
      Promise.resolve(tool.description({} as never, {
        isNonInteractiveSession: false,
        toolPermissionContext: permissionContext,
        tools,
      })),
      350,
      fallback,
    )
    if (!description.trim() || /\bundefined\b/i.test(description)) {
      return fallback
    }
    return description
  } catch {
    return fallbackToolDescription(tool)
  }
}

async function serializeTool(tool: Tool, tools: Tools, permissionContext: ToolPermissionContext): Promise<GuiToolEntry> {
  let readOnly: boolean | null = null
  try {
    readOnly = tool.isReadOnly({} as never)
  } catch {
    readOnly = null
  }

  return {
    name: tool.name,
    description: await toolDescription(tool, tools, permissionContext),
    source: toolSource(tool),
    category: toolCategory(tool),
    read_only: readOnly,
    enabled: tool.isEnabled(),
    mcp_server: tool.mcpInfo?.serverName ?? null,
    mcp_tool: tool.mcpInfo?.toolName ?? null,
    input_schema: tool.inputJSONSchema ?? null,
    should_defer: tool.shouldDefer === true,
  }
}

async function toolCatalog(modeValue: unknown): Promise<GuiToolEntry[]> {
  const mode = permissionModeFromValue(modeValue)
  const permissionContext = toolPermissionContext(mode)
  const tools = assembleToolPool(permissionContext, [])
  const entries = await Promise.all(
    tools.map(tool => serializeTool(tool, tools, permissionContext)),
  )
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

async function modelOptions() {
  return {
    options: getModelOptions().map(option => ({
      id: option.value ?? 'default',
      name: option.label,
      description: option.description,
    })),
  }
}

async function validatedModelValue(model?: string): Promise<string | undefined> {
  const normalized = model?.trim()
  if (!normalized || normalized === 'default' || normalized === 'inherit') {
    return undefined
  }
  return normalized
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

function formatDoctorDiagnostic(diagnostic: DiagnosticInfo): string {
  const warnings = diagnostic.warnings.length > 0
    ? diagnostic.warnings.map((warning, index) => [
        `${index + 1}. ${warning.issue}`,
        `   修复: ${warning.fix}`,
      ].join('\n')).join('\n')
    : '无'

  return [
    'Spark Code Doctor',
    `版本: ${diagnostic.version}`,
    `安装类型: ${diagnostic.installationType}`,
    `安装路径: ${diagnostic.installationPath}`,
    `启动二进制: ${diagnostic.invokedBinary}`,
    `配置安装方式: ${diagnostic.configInstallMethod}`,
    `自动更新: ${diagnostic.autoUpdates}`,
    `更新权限: ${diagnostic.hasUpdatePermissions === null ? '不适用' : diagnostic.hasUpdatePermissions ? '可用' : '不可用'}`,
    `包管理器: ${diagnostic.packageManager ?? '未检测到'}`,
    `Ripgrep: ${diagnostic.ripgrepStatus.working ? '可用' : '不可用'} (${diagnostic.ripgrepStatus.mode}${diagnostic.ripgrepStatus.systemPath ? `: ${diagnostic.ripgrepStatus.systemPath}` : ''})`,
    `多重安装: ${diagnostic.multipleInstallations.length > 0 ? diagnostic.multipleInstallations.map(item => `${item.type} ${item.path}`).join('; ') : '无'}`,
    `建议: ${diagnostic.recommendation ?? '无'}`,
    '',
    '警告',
    warnings,
  ].join('\n')
}

function topModelUsage(stats: ClaudeCodeStats): string {
  const [name, usage] = Object.entries(stats.modelUsage)
    .sort(([, a], [, b]) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))[0] ?? []
  if (!name || !usage) return '暂无'
  return `${name} (${formatNumber(usage.inputTokens + usage.outputTokens)} tokens)`
}

async function formatStatsText(): Promise<string> {
  const stats = await aggregateClaudeCodeStatsForRange('all')
  return [
    'Spark Code Stats',
    `会话数: ${formatNumber(stats.totalSessions)}`,
    `消息数: ${formatNumber(stats.totalMessages)}`,
    `活跃天数: ${formatNumber(stats.activeDays)}/${formatNumber(stats.totalDays)}`,
    `当前连续活跃: ${formatNumber(stats.streaks.currentStreak)} 天`,
    `最长连续活跃: ${formatNumber(stats.streaks.longestStreak)} 天`,
    `最长会话: ${stats.longestSession ? `${formatDuration(stats.longestSession.duration)} (${stats.longestSession.sessionId})` : '暂无'}`,
    `首次会话: ${stats.firstSessionDate ?? '暂无'}`,
    `最近会话: ${stats.lastSessionDate ?? '暂无'}`,
    `高峰日期: ${stats.peakActivityDay ?? '暂无'}`,
    `高峰时段: ${stats.peakActivityHour === null ? '暂无' : `${stats.peakActivityHour}:00-${stats.peakActivityHour + 1}:00`}`,
    `主要模型: ${topModelUsage(stats)}`,
  ].join('\n')
}

async function formatGuiStatusText(config: ServerConfig, cwd: string): Promise<string> {
  const [diagnostic, tools, mcpRuntime] = await Promise.all([
    getDoctorDiagnostic(),
    toolCatalog('default').catch(() => []),
    loadServerMcpRuntime({ timeoutMs: 2_500 }).catch(() => ({
      clients: [],
      tools: [],
      commands: [],
      resources: {},
    })),
  ])
  const modelOptionsCount = getModelOptions().length
  return [
    'Spark Code Status',
    `本地后端: 已启动`,
    `工作目录: ${cwd}`,
    `监听地址: ${config.host ?? '127.0.0.1'}:${config.port && config.port > 0 ? config.port : 'auto'}`,
    `鉴权: ${config.authToken ? '已启用' : '未启用'}`,
    `版本: ${diagnostic.version}`,
    `安装类型: ${diagnostic.installationType}`,
    `模型选项: ${formatNumber(modelOptionsCount)}`,
    `系统工具: ${formatNumber(tools.filter(tool => tool.source === 'builtin').length)}`,
    `MCP 工具: ${formatNumber(tools.filter(tool => tool.source === 'mcp').length)}`,
    `MCP 命令: ${formatNumber(mcpRuntime.commands.length)}`,
    `MCP 资源: ${formatNumber(Object.keys(mcpRuntime.resources ?? {}).length)}`,
    `诊断警告: ${formatNumber(diagnostic.warnings.length)}`,
    `Ripgrep: ${diagnostic.ripgrepStatus.working ? '可用' : '不可用'}`,
  ].join('\n')
}

function createLocalCommandContext({
  commands,
  cwd,
  mcpRuntime,
  sessionId,
}: {
  commands: Command[]
  cwd: string
  mcpRuntime: Awaited<ReturnType<typeof loadServerMcpRuntime>>
  sessionId: string
}): ToolUseContext {
  switchSession(asSessionId(sessionId))
  setOriginalCwd(cwd)
  setProjectRoot(cwd)
  setCwdState(cwd)

  let appState: AppState = {
    ...getDefaultAppState(),
    mcp: {
      ...getDefaultAppState().mcp,
      clients: mcpRuntime.clients,
      tools: mcpRuntime.tools,
      commands: mcpRuntime.commands,
      resources: mcpRuntime.resources,
    },
    toolPermissionContext: getEmptyToolPermissionContext(),
  }
  const tools = assembleToolPool(appState.toolPermissionContext, mcpRuntime.tools)
  const setAppState: ToolUseContext['setAppState'] = updater => {
    appState = updater(appState)
  }

  return {
    options: {
      commands,
      debug: false,
      mainLoopModel: appState.mainLoopModel,
      tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: mcpRuntime.clients,
      mcpResources: mcpRuntime.resources,
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      refreshTools: () => tools,
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    getAppState: () => appState,
    setAppState,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  }
}

async function runLocalCommand(
  name: string,
  args: string,
  cwd: string,
  config: ServerConfig,
): Promise<string> {
  const normalized = name.trim().toLowerCase()
  if (normalized === 'doctor') {
    return formatDoctorDiagnostic(await getDoctorDiagnostic())
  }
  if (normalized === 'status') {
    return formatGuiStatusText(config, cwd)
  }
  if (normalized === 'stats') {
    return formatStatsText()
  }
  if (normalized === 'version') {
    return '0.2.1'
  }

  const wasInteractive = getIsInteractive()
  setIsInteractive(false)
  try {
    const mcpRuntime = await loadServerMcpRuntime({ timeoutMs: 2_500 }).catch(() => ({
      clients: [],
      tools: [],
      commands: [],
      resources: {},
    }))
    const commands = dedupeByName([
      ...GUI_LOCAL_COMMANDS,
      ...mcpRuntime.commands,
    ])
    if (normalized === 'reload-plugins') {
      return [
        '已刷新 GUI 可读取的插件、Skills 和 MCP 配置。',
        `MCP 命令: ${mcpRuntime.commands.length}`,
        `MCP 工具: ${mcpRuntime.tools.length}`,
        '原 TUI 的会话内插件热重载在当前恢复版后端会阻塞，未伪造成成功。',
      ].join('\n')
    }
    const command = findCommand(normalized, commands)

    if (
      !command ||
      command.type !== 'local' ||
      !command.supportsNonInteractive ||
      command.isHidden === true ||
      command.isEnabled?.() === false
    ) {
      if (normalized === 'extra-usage') {
        return '当前账户或组织不支持额外用量配置；原 TUI 也不会启用 /extra-usage。'
      }
      throw new Error(`不支持的 GUI 本地命令：${name}`)
    }

    const module = await command.load()
    const result = await module.call(args, createLocalCommandContext({
      commands,
      cwd,
      mcpRuntime,
      sessionId: `local-command-${Date.now()}`,
    }) as never)
    if (result.type === 'text') {
      return stripAnsi(result.value)
    }
    if (result.type === 'skip') {
      return '已完成'
    }
    return result.displayText ?? '已完成'
  } finally {
    setIsInteractive(wasInteractive)
  }
}

async function submitFeedbackReport(input: {
  cwd: string
  description: string
  messages: FeedbackMessage[]
}): Promise<{ feedback_id: string }> {
  const description = redactFeedbackText(input.description.trim())
  if (!description) {
    throw new Error('反馈内容不能为空')
  }

  setOriginalCwd(input.cwd)
  setProjectRoot(input.cwd)
  setCwdState(input.cwd)

  await checkAndRefreshOAuthTokenIfNeeded().catch(() => undefined)
  const auth = getAuthHeaders()
  if (auth.error) {
    throw new Error(auth.error)
  }

  const gitState = await getGitState().catch(() => null)
  const reportData = {
    latestAssistantMessageId: null,
    message_count: input.messages.length,
    datetime: new Date().toISOString(),
    description,
    platform: process.platform,
    gitRepo: Boolean(gitState),
    terminal: 'Spark Code.app',
    version: '0.2.1',
    transcript: input.messages.map(message => ({
      role: message.role,
      content: redactFeedbackText(message.content ?? ''),
      created_at: message.created_at,
    })),
    gitState,
    source: 'sparkcode-gui',
  }

  const response = await fetch('https://api.anthropic.com/api/claude_cli_feedback', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': getUserAgent(),
      ...auth.headers,
    },
    body: JSON.stringify({ content: JSON.stringify(reportData) }),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(`反馈提交失败：${response.status}`)
  }
  const feedbackId = stringValue(payload.feedback_id)
  if (!feedbackId) {
    throw new Error('反馈提交失败：服务端未返回 feedback_id')
  }
  return { feedback_id: feedbackId }
}

export function startServer(
  config: ServerConfig,
  sessionManager: SessionManager,
  logger: ServerLogger,
): ServerHandle {
  const sockets = new Map<string, Set<ServerWebSocket<{ sessionId: string }>>>()

  const server = Bun.serve<{ sessionId: string }>({
    hostname: config.unix ? undefined : config.host,
    port: config.unix ? undefined : config.port,
    unix: config.unix,
    async fetch(req, bunServer) {
      const url = new URL(req.url)

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(),
        })
      }

      if (url.pathname === '/health' || url.pathname === '/status') {
        return json({ ok: true, version: '0.2.1' })
      }

      if (!isAuthorized(req, config)) {
        return json({ error: 'unauthorized' }, 401)
      }

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/slash-commands') {
        try {
          const body = req.method === 'POST' ? await readJson(req) : {}
          const cwd = stringValue(body.cwd) ||
            url.searchParams.get('cwd') ||
            config.workspace ||
            process.cwd()
          return json(await slashCommands(cwd))
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/model-options') {
        try {
          return json(await modelOptions())
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/tools') {
        try {
          const body = req.method === 'POST' ? await readJson(req) : {}
          const tools = await withTimeout(
            toolCatalog(
              stringValue(body.permission_mode) ||
                url.searchParams.get('permission_mode'),
            ),
            4_000,
            [] as GuiToolEntry[],
          )
          return json(tools)
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/permissions/pending') {
        const body = req.method === 'POST' ? await readJson(req) : {}
        return json(listPendingPermissions(
          stringValue(body.session_id) ||
            stringValue(body.sessionId) ||
            url.searchParams.get('session_id') ||
            undefined,
        ))
      }

      const taskListMatch = url.pathname.match(/^\/sessions\/([^/]+)\/tasks$/)
      if ((req.method === 'GET' || req.method === 'POST') && taskListMatch) {
        try {
          const sessionId = decodeURIComponent(taskListMatch[1])
          const body = req.method === 'POST' ? await readJson(req) : {}
          sessionManager.restoreSession({
            sessionId,
            cwd: stringValue(body.cwd) ?? config.workspace,
            sessionKey: stringValue(body.session_key),
            hasStarted: booleanValue(body.resume) === true,
          })
          return json(sessionManager.listTasks(sessionId))
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 404)
        }
      }

      const permissionResponseMatch = url.pathname.match(/^\/permissions\/([^/]+)\/respond$/)
      if (req.method === 'POST' && permissionResponseMatch) {
        const body = await readJson(req)
        const decision = permissionDecisionValue(body.decision)
        if (!decision) {
          return json({ error: 'invalid permission decision' }, 400)
        }
        const ok = respondToPermissionRequest(
          decodeURIComponent(permissionResponseMatch[1]),
          { decision },
        )
        if (!ok) return json({ error: 'permission request not found' }, 404)
        return json({ ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/auth/clear') {
        clearConfiguredAndroidAuth()
        return json({ ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/local-command') {
        try {
          const body = await readJson(req)
          const content = await runLocalCommand(
            stringValue(body.name) ?? '',
            stringValue(body.args) ?? '',
            stringValue(body.cwd) ?? config.workspace ?? process.cwd(),
            config,
          )
          return json({ content })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if (req.method === 'POST' && url.pathname === '/feedback') {
        try {
          const body = await readJson(req)
          const result = await submitFeedbackReport({
            cwd: stringValue(body.cwd) ?? config.workspace ?? process.cwd(),
            description: stringValue(body.description) ?? '',
            messages: feedbackMessagesFromValue(body.messages),
          })
          return json(result)
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        try {
          const body = await readJson(req)
          const session = sessionManager.createSession({
            cwd: stringValue(body.cwd) ?? config.workspace,
            sessionKey: stringValue(body.session_key),
          })
          return json({
            session_id: session.id,
            ws_url: wsUrl(req, session.id),
            work_dir: session.workDir,
          })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400)
        }
      }

      if (req.method === 'POST' && url.pathname === '/prompt') {
        try {
          const body = await readJson(req)
          const sessionId =
            stringValue(body.session_id) ?? stringValue(body.sessionId)
          const cwd = stringValue(body.cwd) ?? config.workspace
          const session = sessionId
            ? sessionManager.restoreSession({
                sessionId,
                cwd,
                sessionKey: stringValue(body.session_key),
                hasStarted: booleanValue(body.resume) === true,
              })
            : sessionManager.createSession({
                cwd,
                sessionKey: stringValue(body.session_key),
              })
          const images = imageAttachmentsFromValue(body.images)
          const prompt = stringValue(body.prompt) ?? (images.length > 0 ? '请分析这些图片' : '')
          const permissionMode = stringValue(body.permission_mode) ?? stringValue(body.permissionMode)
          const content = await sessionManager.runPrompt(
            session.id,
            await expandedPromptText({
              cwd,
              permissionMode,
              prompt,
              sessionId: session.id,
            }),
            await validatedModelValue(stringValue(body.model)),
            permissionMode,
            images,
          )
          return json({
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content,
          })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      if (req.method === 'POST' && url.pathname === '/prompt/stream') {
        try {
          const body = await readJson(req)
          const sessionId =
            stringValue(body.session_id) ?? stringValue(body.sessionId)
          const cwd = stringValue(body.cwd) ?? config.workspace
          const session = sessionId
            ? sessionManager.restoreSession({
                sessionId,
                cwd,
                sessionKey: stringValue(body.session_key),
                hasStarted: booleanValue(body.resume) === true,
              })
            : sessionManager.createSession({
                cwd,
                sessionKey: stringValue(body.session_key),
              })
          const images = imageAttachmentsFromValue(body.images)
          const prompt = stringValue(body.prompt) ?? (images.length > 0 ? '请分析这些图片' : '')
          const permissionMode = stringValue(body.permission_mode) ?? stringValue(body.permissionMode)
          return streamPromptResponse({
            sessionManager,
            sessionId: session.id,
            prompt: await expandedPromptText({
              cwd,
              permissionMode,
              prompt,
              sessionId: session.id,
            }),
            cwd,
            model: stringValue(body.model),
            permissionMode,
            resume: booleanValue(body.resume) === true,
            images,
          })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      const promptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompt$/)
      if (req.method === 'POST' && promptMatch) {
        try {
          const body = await readJson(req)
          const sessionId = decodeURIComponent(promptMatch[1])
          sessionManager.restoreSession({
            sessionId,
            cwd: stringValue(body.cwd) ?? config.workspace,
            sessionKey: stringValue(body.session_key),
            hasStarted: booleanValue(body.resume) === true,
          })
          const images = imageAttachmentsFromValue(body.images)
          const cwd = stringValue(body.cwd) ?? config.workspace
          const prompt = stringValue(body.prompt) ?? (images.length > 0 ? '请分析这些图片' : '')
          const permissionMode = stringValue(body.permission_mode) ?? stringValue(body.permissionMode)
          const content = await sessionManager.runPrompt(
            sessionId,
            await expandedPromptText({
              cwd,
              permissionMode,
              prompt,
              sessionId,
            }),
            await validatedModelValue(stringValue(body.model)),
            permissionMode,
            images,
          )
          return json({
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content,
          })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      const promptStreamMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompt\/stream$/)
      if (req.method === 'POST' && promptStreamMatch) {
        try {
          const body = await readJson(req)
          const sessionId = decodeURIComponent(promptStreamMatch[1])
          sessionManager.restoreSession({
            sessionId,
            cwd: stringValue(body.cwd) ?? config.workspace,
            sessionKey: stringValue(body.session_key),
            hasStarted: booleanValue(body.resume) === true,
          })
          const images = imageAttachmentsFromValue(body.images)
          const cwd = stringValue(body.cwd) ?? config.workspace ?? process.cwd()
          const prompt = stringValue(body.prompt) ?? (images.length > 0 ? '请分析这些图片' : '')
          const permissionMode = stringValue(body.permission_mode) ?? stringValue(body.permissionMode)
          return streamPromptResponse({
            sessionManager,
            sessionId,
            prompt: await expandedPromptText({
              cwd,
              permissionMode,
              prompt,
              sessionId,
            }),
            cwd,
            model: stringValue(body.model),
            permissionMode,
            resume: booleanValue(body.resume) === true,
            images,
          })
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }

      const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/)
      if (req.method === 'GET' && wsMatch) {
        const sessionId = decodeURIComponent(wsMatch[1])
        const upgraded = bunServer.upgrade(req, {
          data: { sessionId },
        })
        if (!upgraded) {
          return json({ error: 'upgrade failed' }, 400)
        }
        return undefined
      }

      logger.info({ method: req.method, path: url.pathname }, 'not found')
      return json({ error: 'not found' }, 404)
    },
    websocket: {
      open(ws) {
        const { sessionId } = ws.data
        const set = sockets.get(sessionId) ?? new Set()
        set.add(ws)
        sockets.set(sessionId, set)
        ws.send(JSON.stringify({ type: 'connected', session_id: sessionId }))
      },
      message(ws, message) {
        const { sessionId } = ws.data
        void (async () => {
          try {
            const parsed = typeof message === 'string'
              ? JSON.parse(message)
              : JSON.parse(Buffer.from(message).toString('utf8'))
            const content = await sessionManager.runPrompt(
              sessionId,
              promptTextFromValue(parsed?.prompt ?? parsed?.content),
              await validatedModelValue(stringValue(parsed?.model)),
              stringValue(parsed?.permission_mode) ?? stringValue(parsed?.permissionMode)
            )
            ws.send(JSON.stringify({
              type: 'message',
              id: `assistant-${Date.now()}`,
              role: 'assistant',
              content,
            }))
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        })()
      },
      close(ws) {
        const { sessionId } = ws.data
        const set = sockets.get(sessionId)
        if (!set) return
        set.delete(ws)
        if (set.size === 0) sockets.delete(sessionId)
      },
    },
  })

  logger.info({ host: config.host, port: server.port, unix: config.unix }, 'server started')
  return {
    port: server.port,
    stop(force?: boolean) {
      for (const set of sockets.values()) {
        for (const ws of set) ws.close()
      }
      sockets.clear()
      server.stop(force)
      void sessionManager.destroyAll()
    },
  }
}

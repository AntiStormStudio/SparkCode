import { homedir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { QueryEngine } from '../../QueryEngine.js'
import { getCommands } from '../../commands.js'
import { switchSession, setCwdState, setOriginalCwd, setProjectRoot } from '../../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import { createStore, type Store } from '../../state/store.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { assembleToolPool } from '../../tools.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { asSessionId } from '../../types/ids.js'
import {
  clearConfiguredAndroidAuth,
  getConfiguredApiBaseUrl,
  getConfiguredAuthRefreshToken,
} from '../../utils/auth.js'
import { enableConfigs } from '../../utils/config.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileStateCache,
} from '../../utils/fileStateCache.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { applyPermissionUpdates } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'
import { initBuiltinPlugins } from '../../plugins/bundled/index.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import {
  isAutomationSlashCommand,
  isSettingsSlashCommand,
} from '../slashCommandPolicy.js'
import { dedupeByName, loadServerMcpRuntime } from '../mcpRuntime.js'
import { requestGuiPermission } from '../permissionBroker.js'

const AUTH_EXPIRED_MESSAGE =
  '登录已过期或令牌无效，请在设置中登录 Spark，或输入 /login 重新登录'

type EngineRecord = {
  engine: QueryEngine
  store: Store<AppState>
  readFileCache: FileStateCache
}

type ImageAttachment = {
  id?: string
  name?: string
  media_type?: string
  data: string
}

type RuntimeEventHandler = (event: unknown) => void

export type GuiTaskSummary = {
  id: string
  type: string
  status: string
  description: string
  command: string | null
  output_file: string
  output_tail: string | null
  start_time: number
  end_time: number | null
}

let registriesInitialized = false

export function initializeServerRegistries(): void {
  if (registriesInitialized) return
  registriesInitialized = true
  initBuiltinPlugins()
  initBundledSkills()
}

function permissionModeFromValue(value?: string): PermissionMode {
  switch (value?.trim()) {
    case 'acceptEdits':
    case 'auto-review':
    case 'auto':
      return 'acceptEdits'
    case 'bypassPermissions':
    case 'full':
      return 'bypassPermissions'
    case 'dontAsk':
      return 'dontAsk'
    case 'plan':
      return 'plan'
    default:
      return 'default'
  }
}

function sparkConfigEnv(): Record<string, string> {
  const configDir = process.env.SPARK_CONFIG_DIR || join(homedir(), '.sparkc')
  const configPath = join(configDir, 'spark.json')
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    const env = parsed?.env
    if (!env || typeof env !== 'object') return {}
    return Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === 'string' && value.trim()),
    ) as Record<string, string>
  } catch {
    return {}
  }
}

function applySparkEnvironment(): Record<string, string> {
  enableConfigs()
  const configEnv = sparkConfigEnv()
  process.env.ANTHROPIC_BASE_URL =
    configEnv.ANTHROPIC_BASE_URL || getConfiguredApiBaseUrl() || 'https://chat.spark-ai.top'

  if (configEnv.ANTHROPIC_AUTH_TOKEN) {
    process.env.ANTHROPIC_AUTH_TOKEN = configEnv.ANTHROPIC_AUTH_TOKEN
  }

  const refreshToken =
    configEnv.SPARK_ANDROID_REFRESH_TOKEN ||
    (configEnv.ANTHROPIC_AUTH_TOKEN ? getConfiguredAuthRefreshToken() : null)
  if (refreshToken) {
    process.env.SPARK_ANDROID_REFRESH_TOKEN = refreshToken
  }
  if (configEnv.SPARK_ANDROID_INSTALL_ID) {
    process.env.SPARK_ANDROID_INSTALL_ID = configEnv.SPARK_ANDROID_INSTALL_ID
  }
  if (configEnv.SPARK_ANDROID_DEVICE_ID) {
    process.env.SPARK_ANDROID_DEVICE_ID = configEnv.SPARK_ANDROID_DEVICE_ID
  }
  return configEnv
}

function hasSparkAuth(configEnv = sparkConfigEnv()): boolean {
  return !!(
    configEnv.ANTHROPIC_AUTH_TOKEN ||
    configEnv.SPARK_ANDROID_REFRESH_TOKEN ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.SPARK_ANDROID_REFRESH_TOKEN
  )
}

function normalizeError(message: string): string {
  if (/401|Invalid Android token|登录已过期|令牌无效/i.test(message)) {
    clearConfiguredAndroidAuth()
    return AUTH_EXPIRED_MESSAGE
  }
  if (/An unknown error occurred \(Unexpected\)|Method Not Allowed|API Error: 405/i.test(message)) {
    return AUTH_EXPIRED_MESSAGE
  }
  return message
}

function configureSessionGlobals(cwd: string, sessionId: string): void {
  switchSession(asSessionId(sessionId))
  setOriginalCwd(cwd)
  setProjectRoot(cwd)
  setCwdState(cwd)
}

function promptContent(prompt: string, images: ImageAttachment[] = []): string | ContentBlockParam[] {
  if (images.length === 0) return prompt

  const blocks: ContentBlockParam[] = []
  if (prompt.trim()) {
    blocks.push({ type: 'text', text: prompt.trim() })
  }
  for (const image of images) {
    const data = image.data.includes(',')
      ? image.data.split(',').pop() ?? ''
      : image.data
    if (!data.trim()) continue
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.media_type || 'image/png',
        data,
      },
    } as ContentBlockParam)
  }

  return blocks.length > 0 ? blocks : prompt
}

function sessionPermissionUpdates(
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  return (suggestions ?? []).flatMap(update => {
    if (update.type !== 'addRules') return []
    return [{ ...update, destination: 'session' as const }]
  })
}

export class ServerQueryBackend {
  private readonly engines = new Map<string, EngineRecord>()
  private readonly runtimeEventHandlers = new Map<string, RuntimeEventHandler>()

  private emitRuntimeEvent(sessionId: string, event: unknown): void {
    this.runtimeEventHandlers.get(sessionId)?.(event)
  }

  private async createEngine({
    cwd,
    model,
    permissionMode,
    sessionId,
  }: {
    cwd: string
    model?: string
    permissionMode?: string
    sessionId: string
  }): Promise<EngineRecord> {
    initializeServerRegistries()
    configureSessionGlobals(cwd, sessionId)

    const mode = permissionModeFromValue(permissionMode)
    const defaultState = getDefaultAppState()
    const mcpRuntime = await loadServerMcpRuntime()
    const appState: AppState = {
      ...defaultState,
      mcp: {
        ...defaultState.mcp,
        clients: mcpRuntime.clients,
        tools: mcpRuntime.tools,
        commands: mcpRuntime.commands,
        resources: mcpRuntime.resources,
      },
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        mode,
        isBypassPermissionsModeAvailable: mode === 'bypassPermissions',
      },
    }
    const store = createStore(appState)
    const commands = dedupeByName([
      ...await getCommands(cwd),
      ...mcpRuntime.commands,
    ])
    const agents = await getAgentDefinitionsWithOverrides(cwd)
    const tools = assembleToolPool(
      store.getState().toolPermissionContext,
      mcpRuntime.tools,
    )
    const readFileCache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    const canUseGuiTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const permissionResult =
        forceDecision ??
        await hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
        )

      if (permissionResult.behavior === 'allow' || permissionResult.behavior === 'deny') {
        return permissionResult
      }

      const currentState = toolUseContext.getAppState()
      const description = await tool.description(input as never, {
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        toolPermissionContext: currentState.toolPermissionContext,
        tools: toolUseContext.options.tools,
      })
      const response = await requestGuiPermission({
        sessionId,
        toolUseId: toolUseID,
        toolName: tool.name,
        message: permissionResult.message || `${tool.name} 需要权限`,
        description,
        toolInput: input,
        suggestions: permissionResult.suggestions ?? [],
        blockedPath: permissionResult.blockedPath,
        onRequest: request => {
          this.emitRuntimeEvent(sessionId, {
            type: 'permission_request',
            request,
          })
        },
      })

      if (response.decision === 'deny') {
        return {
          behavior: 'deny',
          message: `用户拒绝了 ${tool.name} 权限请求`,
          decisionReason: {
            type: 'permissionPromptTool',
            permissionPromptToolName: 'Spark Code GUI',
            toolResult: response,
          },
        }
      }

      const updates =
        response.decision === 'allow_session'
          ? sessionPermissionUpdates(permissionResult.suggestions)
          : []
      if (updates.length > 0) {
        toolUseContext.setAppState(prev => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdates(
            prev.toolPermissionContext,
            updates,
          ),
        }))
      }

      return {
        behavior: 'allow',
        updatedInput: permissionResult.updatedInput ?? input,
        decisionReason: {
          type: 'permissionPromptTool',
          permissionPromptToolName: 'Spark Code GUI',
          toolResult: {
            ...response,
            updatedPermissions: updates,
          },
        },
      } satisfies PermissionDecision<Record<string, unknown>>
    }
    const engine = new QueryEngine({
      cwd,
      tools,
      commands: commands.filter(command =>
        (command.type === 'prompt' && command.disableNonInteractive !== true) ||
        (command.type === 'local' && command.supportsNonInteractive),
      ),
      mcpClients: mcpRuntime.clients,
      agents: agents.activeAgents,
      canUseTool: canUseGuiTool,
      getAppState: store.getState,
      setAppState: store.setState,
      initialMessages: [] as Message[],
      readFileCache,
      userSpecifiedModel: model && model !== 'default' && model !== 'inherit' ? model : undefined,
      thinkingConfig: { type: 'disabled' },
      maxTurns: 25,
    })
    return { engine, store, readFileCache }
  }

  listTasks(sessionId: string): GuiTaskSummary[] {
    const record = this.engines.get(sessionId)
    if (!record) return []
    return Object.values(record.store.getState().tasks ?? {}).map(task => {
      let outputTail: string | null = null
      try {
        const content = readFileSync(task.outputFile, 'utf8')
        outputTail = content.length > 4_000 ? content.slice(-4_000) : content
      } catch {
        outputTail = null
      }
      return {
        id: task.id,
        type: task.type,
        status: task.status,
        description: task.description,
        command: 'command' in task && typeof task.command === 'string' ? task.command : null,
        output_file: task.outputFile,
        output_tail: outputTail,
        start_time: task.startTime,
        end_time: task.endTime ?? null,
      }
    })
  }

  async runPrompt({
    prompt,
    cwd,
    model,
    permissionMode,
    resume,
    sessionId,
    images = [],
    onEvent,
  }: {
    prompt: string
    cwd: string
    model?: string
    permissionMode?: string
    sessionId: string
    resume: boolean
    images?: ImageAttachment[]
    onEvent?: (event: unknown) => void
  }): Promise<string> {
    const trimmed = prompt.trim()
    const effectivePrompt = trimmed || (images.length > 0 ? '请分析这些图片' : '')
    if (!effectivePrompt) {
      throw new Error('请输入要发送的内容')
    }
    if (effectivePrompt === '/__sparkcode_healthcheck') {
      return 'Spark Code 本地后端已连接'
    }

    const parsedSlash = parseSlashCommand(effectivePrompt)
    if (parsedSlash) {
      const commandName = parsedSlash.commandName.toLowerCase()
      if (isSettingsSlashCommand(commandName)) {
        return '这个功能已移到设置里，不再通过 / 命令执行'
      }
      if (isAutomationSlashCommand(commandName)) {
        return '这个功能已从 Spark Code App 中移除'
      }
    }

    const configEnv = applySparkEnvironment()
    if (!hasSparkAuth(configEnv)) {
      throw new Error(AUTH_EXPIRED_MESSAGE)
    }

    try {
      configureSessionGlobals(cwd, sessionId)
      if (onEvent) {
        this.runtimeEventHandlers.set(sessionId, onEvent)
      } else {
        this.runtimeEventHandlers.delete(sessionId)
      }
      const record = resume
        ? this.engines.get(sessionId) ?? await this.createEngine({ cwd, model, permissionMode, sessionId })
        : await this.createEngine({ cwd, model, permissionMode, sessionId })
      this.engines.set(sessionId, record)

      let result = ''
      for await (const message of record.engine.submitMessage(promptContent(effectivePrompt, images))) {
        onEvent?.(message)
        if (message.type === 'result') {
          if ('result' in message && typeof message.result === 'string') {
            result = message.result
          }
          if ('is_error' in message && message.is_error) {
            const errors = 'errors' in message && Array.isArray(message.errors)
              ? message.errors.join('\n')
              : result || '执行失败'
            throw new Error(errors)
          }
        }
      }
      return result.trim() || '已完成'
    } catch (error) {
      throw new Error(normalizeError(error instanceof Error ? error.message : String(error)))
    } finally {
      this.runtimeEventHandlers.delete(sessionId)
    }
  }
}

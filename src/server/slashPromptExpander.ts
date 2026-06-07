import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  findCommand,
  getCommands,
  getCommandName,
  type Command,
} from '../commands.js'
import { switchSession, setCwdState, setOriginalCwd, setProjectRoot } from '../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../Tool.js'
import type { PermissionMode } from '../types/permissions.js'
import type { Message, UserMessage } from '../types/message.js'
import { asSessionId } from '../types/ids.js'
import { assembleToolPool } from '../tools.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js'
import { parseSlashCommand } from '../utils/slashCommandParsing.js'
import { processPromptSlashCommand } from '../utils/processUserInput/processSlashCommand.js'
import { isHiddenFromGuiSlashList } from './slashCommandPolicy.js'
import {
  dedupeByName,
  loadServerMcpRuntime,
  type ServerMcpRuntime,
} from './mcpRuntime.js'

export type ExpandedSlashPrompt = {
  blocked?: false
  prompt: string
  allowedTools: string[]
  model?: string
} | {
  blocked: true
  message: string
}

function permissionModeFromValue(value?: string): PermissionMode {
  switch (value) {
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

function createServerToolContext({
  commands,
  cwd,
  messages,
  mcpRuntime,
  permissionMode,
  sessionId,
}: {
  commands: Command[]
  cwd: string
  messages: Message[]
  mcpRuntime: ServerMcpRuntime
  permissionMode?: string
  sessionId: string
}): ToolUseContext {
  switchSession(asSessionId(sessionId))
  setOriginalCwd(cwd)
  setProjectRoot(cwd)
  setCwdState(cwd)

  let appState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: permissionModeFromValue(permissionMode),
      isBypassPermissionsModeAvailable:
        permissionModeFromValue(permissionMode) === 'bypassPermissions',
    },
  }
  const tools = assembleToolPool(
    appState.toolPermissionContext,
    mcpRuntime.tools,
  )

  const setAppState: ToolUseContext['setAppState'] = updater => {
    appState = updater(appState)
  }

  return {
    options: {
      commands,
      debug: false,
      mainLoopModel: '',
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
    messages,
  }
}

function blockToText(block: ContentBlockParam): string {
  if (block.type === 'text') return block.text
  if ('text' in block && typeof block.text === 'string') return block.text
  return ''
}

function userMessageToText(message: UserMessage): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  return content
    .map(block => blockToText(block as ContentBlockParam))
    .filter(Boolean)
    .join('\n')
}

export async function expandSlashPromptForServer({
  cwd,
  messages = [],
  permissionMode,
  prompt,
  sessionId,
}: {
  cwd: string
  messages?: Message[]
  permissionMode?: string
  prompt: string
  sessionId: string
}): Promise<ExpandedSlashPrompt | null> {
  const parsed = parseSlashCommand(prompt)
  if (!parsed) return null

  const mcpRuntime = await loadServerMcpRuntime().catch(() => ({
    clients: [],
    tools: [],
    commands: [],
    resources: {},
  }))
  const commands = dedupeByName([
    ...await getCommands(cwd),
    ...mcpRuntime.commands,
  ])
  const command = findCommand(parsed.commandName, commands)
  if (!command || command.type !== 'prompt') return null
  if (isHiddenFromGuiSlashList({
    name: getCommandName(command),
    description: command.description,
    category: command.loadedFrom,
    loaded_from: command.loadedFrom,
    source: command.source,
  })) {
    return {
      blocked: true,
      message: '这个功能已移到设置里，不再通过 / 命令执行',
    }
  }
  if (command.context === 'fork') return null
  if (command.disableNonInteractive === true) return null

  const result = await processPromptSlashCommand(
    getCommandName(command),
    parsed.args,
    commands,
    createServerToolContext({
      commands,
      cwd,
      messages,
      mcpRuntime,
      permissionMode,
      sessionId,
    }),
  )

  if (!result.shouldQuery) return null

  const expanded = result.messages
    .filter((message): message is UserMessage => message.type === 'user')
    .map(userMessageToText)
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (!expanded) return null

  return {
    prompt: expanded,
    allowedTools: result.allowedTools ?? [],
    model: result.model,
  }
}

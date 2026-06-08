import type { UUID } from 'crypto'
import { getSessionId, setMainLoopModelOverride } from '../../bootstrap/state.js'
import type { StdoutMessage } from '../../entrypoints/sdk/controlTypes.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { LogOption } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { sleep } from '../../utils/sleep.js'
import { notifySessionMetadataChanged } from '../../utils/sessionState.js'
import {
  getSessionIdFromLog,
  loadAllProjectsMessageLogs,
  loadFullLog,
} from '../../utils/sessionStorage.js'
import {
  createSparkCodeEvent,
  getSparkCodeCredentials,
  getSparkCodeSessionEvents,
  updateSparkCodeCurrentSession,
  upsertSparkCodeCurrentSession,
  type SparkCodeEvent,
  type SparkCodeRemoteCredentials,
  type SparkCodeSession,
} from './client.js'

const POLL_INTERVAL_MS = 1200
const ERROR_BACKOFF_MS = 5000
const PAGE_LIMIT = 500
const MAX_CURRENT_MESSAGES = 80
const MAX_HISTORY_SESSIONS = 10
const MAX_HISTORY_MESSAGES = 30
const MAX_MESSAGE_TEXT_LENGTH = 1200
const MAX_EVENT_CONTENT_LENGTH = 24000

type SetAppState = (f: (prev: AppState) => AppState) => void

type SparkCodeRemoteBridgeOptions = {
  setAppState?: SetAppState
  onEnqueued?: () => void
  getMessages?: () => Message[]
}

type SparkCodeRemoteBridgeState = {
  credentials: SparkCodeRemoteCredentials
  session: SparkCodeSession | null
  abortController: AbortController
  options: SparkCodeRemoteBridgeOptions
  lastEventId?: string
  lastEventAt?: number
  processedEventIds: Set<string>
  primed: boolean
  uploadQueue: Promise<void>
}

export type SparkCodeRemoteBridgeHandle = {
  stop: () => void
  sessionId: string
}

let activeBridge: SparkCodeRemoteBridgeState | null = null

export function startSparkCodeRemoteBridge(
  options: SparkCodeRemoteBridgeOptions = {},
): SparkCodeRemoteBridgeHandle | null {
  const credentials = getSparkCodeCredentials()
  if (!credentials) return null

  if (
    activeBridge &&
    !activeBridge.abortController.signal.aborted &&
    activeBridge.credentials.clientToken === credentials.clientToken &&
    activeBridge.credentials.endpoint === credentials.endpoint
  ) {
    activeBridge.options = { ...activeBridge.options, ...options }
    return {
      stop: () => stopSparkCodeRemoteBridge(),
      sessionId: getSessionId(),
    }
  }

  stopSparkCodeRemoteBridge()

  const state: SparkCodeRemoteBridgeState = {
    credentials,
    session: null,
    abortController: new AbortController(),
    options,
    processedEventIds: new Set(),
    primed: false,
    uploadQueue: Promise.resolve(),
  }
  activeBridge = state
  void runBridge(state)

  return {
    stop: () => stopSparkCodeRemoteBridge(),
    sessionId: getSessionId(),
  }
}

export function stopSparkCodeRemoteBridge(): void {
  if (!activeBridge) return
  activeBridge.abortController.abort()
  activeBridge = null
}

export function publishSparkCodeOutput(message: StdoutMessage | Message): void {
  const state = activeBridge
  if (!state || state.abortController.signal.aborted) return

  const eventType = classifyOutputEvent(message)
  if (!eventType) return

  const content = extractOutputText(message)
  state.uploadQueue = state.uploadQueue
    .catch(() => undefined)
    .then(async () => {
      const session = await ensureSession(state)
      if (!session || state.abortController.signal.aborted) return
      await createSparkCodeEvent(state.credentials, session.id, {
        type: eventType,
        source: 'client',
        content: content || undefined,
        data: {
          message,
          ...(eventType === 'sdk_message' ? { sdk_message: message } : {}),
          model: getMainLoopModel(),
        },
      })
    })
    .catch(error => {
      logForDebugging(
        `[spark-code:remote] failed to publish output: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
}

async function runBridge(state: SparkCodeRemoteBridgeState): Promise<void> {
  while (!state.abortController.signal.aborted) {
    try {
      await ensureSession(state)
      if (!state.primed) {
        await primeCursor(state)
      }
      await pollRemoteEvents(state)
      await sleep(POLL_INTERVAL_MS, state.abortController.signal, {
        unref: true,
      })
    } catch (error) {
      logForDebugging(
        `[spark-code:remote] bridge loop failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      await sleep(ERROR_BACKOFF_MS, state.abortController.signal, {
        unref: true,
      })
    }
  }
}

async function ensureSession(
  state: SparkCodeRemoteBridgeState,
): Promise<SparkCodeSession | null> {
  if (state.session?.id === getSessionId()) {
    return state.session
  }

  const session = await upsertSparkCodeCurrentSession(state.credentials)
  state.session = session
  state.primed = false
  state.lastEventId = undefined
  state.lastEventAt = undefined
  state.processedEventIds.clear()

  await createSparkCodeEvent(state.credentials, session.id, {
    type: 'status',
    source: 'client',
    content: 'Spark Code remote bridge connected',
    data: {
      status: 'active',
      model: getMainLoopModel(),
    },
  }).catch(error => {
    logForDebugging(
      `[spark-code:remote] failed to publish bridge status: ${error instanceof Error ? error.message : String(error)}`,
    )
  })

  return session
}

async function primeCursor(state: SparkCodeRemoteBridgeState): Promise<void> {
  const session = await ensureSession(state)
  if (!session) return

  const page = await getSparkCodeSessionEvents(state.credentials, session.id, {
    source: 'user',
    order: 'desc',
    limit: PAGE_LIMIT,
  })
  for (const event of page.items) {
    rememberProcessedEvent(state, event.id)
  }

  const latestEvent = page.items[0]
  state.lastEventId = latestEvent?.id
  state.lastEventAt = latestEvent?.created_at
  state.primed = true
}

async function pollRemoteEvents(
  state: SparkCodeRemoteBridgeState,
): Promise<void> {
  const session = await ensureSession(state)
  if (!session) return

  const page = await getSparkCodeSessionEvents(state.credentials, session.id, {
    source: 'user',
    afterId: state.lastEventId,
    after: state.lastEventAt,
    limit: PAGE_LIMIT,
  })

  for (const event of page.items) {
    if (state.processedEventIds.has(event.id)) continue
    state.lastEventId = event.id
    state.lastEventAt = Math.max(state.lastEventAt ?? 0, event.created_at)
    rememberProcessedEvent(state, event.id)
    await handleRemoteEvent(state, event)
  }
}

function rememberProcessedEvent(
  state: SparkCodeRemoteBridgeState,
  eventId: string,
): void {
  state.processedEventIds.add(eventId)
  if (state.processedEventIds.size <= 1000) return
  const first = state.processedEventIds.values().next().value
  if (first) state.processedEventIds.delete(first)
}

async function handleRemoteEvent(
  state: SparkCodeRemoteBridgeState,
  event: SparkCodeEvent,
): Promise<void> {
  if (event.type === 'model_change') {
    await applyRemoteModelChange(state, extractModel(event))
    return
  }

  if (event.type === 'conversation_sync_request') {
    await publishCurrentConversationSnapshot(state, event)
    return
  }

  if (event.type === 'history_request') {
    await publishConversationHistory(state, event)
    return
  }

  if (event.type === 'conversation_request') {
    await publishConversationById(state, event)
    return
  }

  if (event.type !== 'message') return

  const content = extractEventText(event)
  if (!content.trim()) return

  enqueue({
    value: content.trim(),
    mode: 'prompt',
    uuid: event.id as UUID,
    priority: 'next',
    skipSlashCommands: true,
    bridgeOrigin: true,
    origin: {
      kind: 'spark-code',
      eventId: event.id,
      sessionId: event.session_id,
    },
  })
  state.options.onEnqueued?.()
}

async function publishCurrentConversationSnapshot(
  state: SparkCodeRemoteBridgeState,
  requestEvent?: SparkCodeEvent,
): Promise<void> {
  const session = await ensureSession(state)
  if (!session) return

  const snapshot = conversationSnapshotFromMessages({
    id: getSessionId(),
    title: session.title,
    source: 'current',
    messages: state.options.getMessages?.() ?? [],
    maxMessages: MAX_CURRENT_MESSAGES,
  })

  await createSparkCodeEvent(state.credentials, session.id, {
    type: 'conversation_snapshot',
    source: 'client',
    content: snapshotToMarkdown(snapshot),
    data: {
      ...snapshot,
      request_event_id: requestEvent?.id,
    },
  })
}

async function publishConversationHistory(
  state: SparkCodeRemoteBridgeState,
  requestEvent: SparkCodeEvent,
): Promise<void> {
  const session = await ensureSession(state)
  if (!session) return

  const requestedLimit = numberFromUnknown(requestEvent.data?.limit)
  const limit = Math.min(Math.max(requestedLimit ?? MAX_HISTORY_SESSIONS, 1), 20)
  const logs = await loadAllProjectsMessageLogs(limit, {
    initialEnrichCount: limit,
  }).catch(error => {
    logForDebugging(
      `[spark-code:remote] failed to load history: ${error instanceof Error ? error.message : String(error)}`,
    )
    return [] as LogOption[]
  })

  const fullLogs = await Promise.all(
    logs.slice(0, limit).map(log => loadFullLog(log).catch(() => log)),
  )
  const conversations = fullLogs.map(log => logToConversationSnapshot(log))

  await createSparkCodeEvent(state.credentials, session.id, {
    type: 'conversation_history',
    source: 'client',
    content: historyToMarkdown(conversations),
    data: {
      conversations,
      total: conversations.length,
      request_event_id: requestEvent.id,
    },
  })
}

async function publishConversationById(
  state: SparkCodeRemoteBridgeState,
  requestEvent: SparkCodeEvent,
): Promise<void> {
  const session = await ensureSession(state)
  if (!session) return

  const requestedSessionId = stringFromUnknown(
    requestEvent.data?.session_id ?? requestEvent.data?.sessionId ?? requestEvent.content,
  )
  if (!requestedSessionId) {
    await createSparkCodeEvent(state.credentials, session.id, {
      type: 'status',
      source: 'client',
      content: '缺少要读取的历史对话 ID',
      data: { status: 'error' },
      meta: { remote_event: 'conversation_request_error' },
    })
    return
  }

  const logs = await loadAllProjectsMessageLogs(50, {
    initialEnrichCount: 50,
  }).catch(() => [] as LogOption[])
  const match = logs.find(log => getSessionIdFromLog(log) === requestedSessionId)
  if (!match) {
    await createSparkCodeEvent(state.credentials, session.id, {
      type: 'status',
      source: 'client',
      content: `没有找到历史对话：${requestedSessionId}`,
      data: { status: 'error' },
      meta: { remote_event: 'conversation_not_found' },
    })
    return
  }

  const fullLog = await loadFullLog(match)
  const snapshot = logToConversationSnapshot(fullLog, MAX_CURRENT_MESSAGES)
  await createSparkCodeEvent(state.credentials, session.id, {
    type: 'conversation_snapshot',
    source: 'client',
    content: snapshotToMarkdown(snapshot),
    data: {
      ...snapshot,
      request_event_id: requestEvent.id,
    },
  })
}

async function applyRemoteModelChange(
  state: SparkCodeRemoteBridgeState,
  requestedModel: string,
): Promise<void> {
  if (!requestedModel) return

  const isDefaultModel = requestedModel === 'default'
  const resolved = isDefaultModel ? undefined : parseUserSpecifiedModel(requestedModel)

  setMainLoopModelOverride(resolved)
  const effectiveModel = getMainLoopModel()
  notifySessionMetadataChanged({ model: effectiveModel })
  state.options.setAppState?.(prev => {
    const sessionModel = resolved ?? null
    if (prev.mainLoopModelForSession === sessionModel) return prev
    return {
      ...prev,
      mainLoopModelForSession: sessionModel,
    }
  })

  const session = await ensureSession(state)
  if (!session) return
  state.session = await updateSparkCodeCurrentSession(state.credentials, session.id, {
    data: {
      ...(session.data ?? {}),
      model: requestedModel,
      resolved_model: effectiveModel,
    },
  })

  await createSparkCodeEvent(state.credentials, session.id, {
    type: 'status',
    source: 'client',
    content: `Model switched to ${effectiveModel}`,
    data: {
      status: 'active',
      model: requestedModel,
      resolved_model: effectiveModel,
    },
    meta: {
      remote_event: 'model_change_ack',
    },
  }).catch(error => {
    logForDebugging(
      `[spark-code:remote] failed to publish model ack: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

function classifyOutputEvent(message: StdoutMessage | Message): string | null {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return null
  }
  if (message.type === 'user') return null
  if (message.type === 'assistant') return 'assistant'
  if (message.type === 'stream_event') return 'stream_event'
  if (message.type === 'tool_progress') return 'tool_progress'
  if (message.type === 'result') return 'result'
  if (message.type === 'system') return 'status'
  if (message.type === 'progress') return 'tool_progress'
  return 'sdk_message'
}

function extractEventText(event: SparkCodeEvent): string {
  if (event.content) return event.content
  const data = event.data ?? {}
  const value = data.message ?? data.content ?? data.text ?? data.prompt
  return stringifyText(value)
}

function extractModel(event: SparkCodeEvent): string {
  const data = event.data ?? {}
  const value = data.model ?? event.content
  return typeof value === 'string' ? value.trim() : ''
}

function extractOutputText(message: StdoutMessage | Message): string {
  if (!message || typeof message !== 'object') return ''
  if ('message' in message && message.message && typeof message.message === 'object') {
    const content = (message.message as { content?: unknown }).content
    return stringifyText(content)
  }
  if ('event' in message && message.event && typeof message.event === 'object') {
    const event = message.event as Record<string, unknown>
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text
    }
    if (
      event.type === 'content_block_start' &&
      event.content_block &&
      typeof event.content_block === 'object'
    ) {
      const block = event.content_block as Record<string, unknown>
      if (block.type === 'tool_use') {
        return `调用工具：${String(block.name ?? block.id ?? 'tool')}`
      }
    }
  }
  if ('content' in message) return stringifyText(message.content)
  if ('result' in message) return stringifyText(message.result)
  if ('status' in message) return stringifyText(message.status)
  return ''
}

function stringifyText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!value) return ''
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (!item || typeof item !== 'object') return stringifyText(item)
        const block = item as Record<string, unknown>
        if (block.type === 'text') return stringifyText(block.text)
        if (block.type === 'thinking') return stringifyText(block.thinking)
        if (block.type === 'tool_use') {
          return `调用工具：${String(block.name ?? block.id ?? 'tool')}`
        }
        if (block.type === 'tool_result') return stringifyText(block.content)
        return stringifyText(block.text ?? block.content)
      })
      .filter(Boolean)
      .join('\n\n')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

type ConversationMessageSnapshot = {
  role: string
  content: string
  timestamp?: string
  uuid?: string
}

type ConversationSnapshot = {
  id: string
  title: string
  source: 'current' | 'history'
  created_at?: string
  updated_at?: string
  project_path?: string
  message_count: number
  messages: ConversationMessageSnapshot[]
}

function conversationSnapshotFromMessages({
  id,
  title,
  source,
  messages,
  maxMessages,
}: {
  id: string
  title: string
  source: 'current' | 'history'
  messages: Message[]
  maxMessages: number
}): ConversationSnapshot {
  const visible = messages
    .map(messageToConversationSnapshot)
    .filter((message): message is ConversationMessageSnapshot => !!message)
  return {
    id,
    title,
    source,
    message_count: visible.length,
    messages: visible.slice(Math.max(0, visible.length - maxMessages)),
  }
}

function logToConversationSnapshot(
  log: LogOption,
  maxMessages: number = MAX_HISTORY_MESSAGES,
): ConversationSnapshot {
  const id = getSessionIdFromLog(log) ?? ''
  const title = log.customTitle || log.summary || log.firstPrompt || id.slice(0, 8)
  const visible = log.messages
    .map(messageToConversationSnapshot)
    .filter((message): message is ConversationMessageSnapshot => !!message)
  return {
    id,
    title,
    source: 'history',
    created_at: log.created?.toISOString?.(),
    updated_at: log.modified?.toISOString?.() ?? log.date,
    project_path: log.projectPath,
    message_count: visible.length || log.messageCount,
    messages: visible.slice(Math.max(0, visible.length - maxMessages)),
  }
}

function messageToConversationSnapshot(
  message: Message,
): ConversationMessageSnapshot | null {
  if (!message || typeof message !== 'object') return null
  if (message.isMeta || message.isVirtual) return null

  const content = extractOutputText(message).trim()
  if (!content) return null

  return {
    role: messageRole(message),
    content: truncateText(content, MAX_MESSAGE_TEXT_LENGTH),
    timestamp: stringFromUnknown(message.timestamp ?? message.createdAt),
    uuid: stringFromUnknown(message.uuid),
  }
}

function messageRole(message: Message): string {
  if (message.type === 'assistant') return 'assistant'
  if (message.type === 'user') return 'user'
  if (message.type === 'system') return 'system'
  return message.type
}

function snapshotToMarkdown(snapshot: ConversationSnapshot): string {
  const lines = [
    `### ${snapshot.source === 'current' ? '当前对话' : '历史对话'}：${snapshot.title}`,
    '',
    `对话 ID：${snapshot.id || '-'}`,
    `消息数：${snapshot.message_count}`,
  ]
  if (snapshot.project_path) lines.push(`项目：${snapshot.project_path}`)
  if (snapshot.updated_at) lines.push(`更新时间：${snapshot.updated_at}`)
  lines.push('')

  for (const message of snapshot.messages) {
    lines.push(`**${roleLabel(message.role)}**`)
    lines.push(message.content)
    lines.push('')
  }

  return truncateText(lines.join('\n'), MAX_EVENT_CONTENT_LENGTH)
}

function historyToMarkdown(conversations: ConversationSnapshot[]): string {
  if (conversations.length === 0) {
    return '没有读取到历史对话。'
  }

  const lines = ['### 历史对话', '']
  for (const conversation of conversations) {
    lines.push(`#### ${conversation.title}`)
    lines.push(`ID：${conversation.id || '-'}`)
    if (conversation.project_path) lines.push(`项目：${conversation.project_path}`)
    if (conversation.updated_at) lines.push(`更新时间：${conversation.updated_at}`)
    lines.push(`消息数：${conversation.message_count}`)
    lines.push('')
    for (const message of conversation.messages) {
      lines.push(`**${roleLabel(message.role)}** ${message.content}`)
      lines.push('')
    }
  }
  return truncateText(lines.join('\n'), MAX_EVENT_CONTENT_LENGTH)
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'system') return '系统'
  return role
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength).trimEnd()}\n\n...`
}

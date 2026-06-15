import {
  Archive,
  AtSign,
  ArrowLeft,
  ArrowUp,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  FilePenLine,
  FileText,
  FolderSymlink,
  FolderTree,
  GitBranch,
  History,
  KeyRound,
  Loader2,
  MessageSquareText,
  Network,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Pencil,
  Plus,
  Search,
  Send,
  ServerCog,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Target,
  TerminalSquare,
  Trash2,
  Undo2,
  X,
  ListChecks,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, MouseEvent } from 'react'
import type {
  AppPreferences,
  AppSnapshot,
  BackendRuntime,
  ChatMessage,
  GuiPermissionDecision,
  GuiPermissionRequest,
  ImageAttachment,
  MemoryDocument,
  McpServerEntry,
  ModelConfig,
  PermissionMode,
  ProjectDirectoryEntry,
  ProjectFileEntry,
  ProjectFileDocument,
  ProjectEntry,
  RecentChange,
  RemoteDeviceBinding,
  RuntimeEvent,
  Session,
  SkillEntry,
  SparkUserProfile,
  SlashCommandEntry,
  ToolEntry,
  UpdateStatus,
} from './types'

type AppView = 'chat' | 'settings'
type CenterPanel = 'conversation' | 'thinking' | 'editing'
type SettingsSection = 'general' | 'appearance' | 'profile' | 'personalization' | 'tools' | 'remote' | 'environment' | 'worktree' | 'archived'
type QueuedPrompt = {
  id: string
  content: string
  images: ImageAttachment[]
  sessionId: string
  sessionTitle: string
  createdAt: number
}
type GuiTaskSummary = {
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
type ContextMenuState =
  | {
      type: 'session'
      x: number
      y: number
      sessionId: string
    }

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
type TauriBridgeWindow = Window &
  typeof globalThis & {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke
      }
      invoke?: TauriInvoke
    }
    __TAURI_INTERNALS__?: {
      invoke?: TauriInvoke
    }
  }

const FIXED_BACKEND_URL = 'https://chat.spark-ai.top'
const ACTIVE_PROJECT_STORAGE_KEY = 'sparkcode-active-project-path'
const CONVERSATION_STORAGE_KEY = 'sparkcode-conversation-state-v1'
const ARCHIVED_SESSIONS_STORAGE_KEY = 'sparkcode-archived-sessions-v1'
const UI_DENSITY_STORAGE_KEY = 'sparkcode-ui-density'
const NO_PROJECT_SELECTION = '__sparkcode_no_project__'
const MAX_STORED_SESSIONS = 48
const MAX_STORED_MESSAGES_PER_SESSION = 80
const MAX_STORED_MESSAGE_CHARS = 40_000
const LONG_IDLE_DIVIDER_MS = 24 * 60 * 60 * 1000
const UPDATE_POLL_INTERVAL_MS = 60 * 1000
const TAURI_INVOKE_UNAVAILABLE_MESSAGE = '当前页面不是 Spark Code Tauri 运行环境，无法调用后端。请从 Spark Code.app 启动。'

type StoredConversationState = {
  activeSessionId: string
  sessions: Session[]
  messages: Record<string, ChatMessage[]>
}

type ArchivedSessionEntry = {
  session: Session
  messages: ChatMessage[]
  archivedAt: number
}

type MemoryEntry = {
  id: string
  text: string
}

type ComposerMode = 'write' | 'plan' | 'goal'
type ReviewDiffRow = {
  type: 'same' | 'added' | 'removed'
  oldLine: number | null
  newLine: number | null
  text: string
}
type ReviewDiffState = {
  changeId: string
  rows: ReviewDiffRow[]
  error: string | null
}

const fallbackSnapshot: AppSnapshot = {
  version: '0.2.1',
  remote: {
    backend_url: FIXED_BACKEND_URL,
    configured: true,
  },
  spark_user: {
    logged_in: false,
    id: null,
    name: null,
    email: null,
    avatar_url: null,
    organization_id: null,
    organization_name: null,
    billing_type: null,
    account_created_at: null,
  },
  remote_device: {
    configured: false,
    bound: false,
    install_id: null,
    device_id: null,
    binding_id: null,
    client_name: null,
    package_name: 'com.sparkatlas.app',
    app_version: '9.0.3',
    status: '未绑定',
  },
  preferences: {
    permission_mode: 'limited',
    remote_control_at_startup: null,
    auto_compact_enabled: true,
    show_turn_duration: true,
    terminal_progress_bar_enabled: true,
    file_checkpointing_enabled: true,
    respect_gitignore: true,
    copy_full_response: false,
    auto_connect_ide: false,
    auto_install_ide_extension: true,
  },
  model: {
    selected: '',
    options: [],
  },
  workspace: {
    folder: '当前项目',
    path: '',
    mode: '编写模式',
    git_branch: null,
  },
  skills: [],
  mcp_servers: [],
  tools: [],
  projects: [],
  recent_changes: [],
  slash_commands: [],
  backend_runtime: {
    local_url: null,
    auth_token: 'sparkcode-app-local',
    streaming_enabled: true,
    context_limit: 1_000_000,
  },
  update_status: {
    current_version: '0.2.1',
    current_revision: null,
    latest_revision: null,
    checked_at: 0,
    update_available: false,
    source: 'bundle',
    detail: '等待检测更新',
    release_url: null,
    error: null,
  },
  sessions: [
    {
      id: 'local-session',
      title: '当前会话',
      tokens: 0,
      context_used: 0,
      context_limit: 1_000_000,
      project_path: '',
      remote: true,
    },
  ],
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const rounded = Math.round(value / 100_000) / 10
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}M` : `${rounded}M`
  }
  if (value >= 1_000) {
    const rounded = Math.round(value / 100) / 10
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}K` : `${rounded}K`
  }
  return `${value}`
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'session'
}

function formatModelName(model: ModelConfig): string {
  return model.options.find(option => option.id === model.selected)?.name ?? model.selected
}

function displayValue(value: string | null | undefined, fallback = '未设置'): string {
  return value?.trim() || fallback
}

function sparkUserPrimary(user: SparkUserProfile): string {
  return displayValue(user.email ?? user.name ?? user.id, user.logged_in ? '已登录，资料未同步' : '未登录')
}

function sparkUserSecondary(user: SparkUserProfile): string {
  if (!user.logged_in) return '请先登录 Spark'
  if (user.email && user.name && user.email !== user.name) return user.name
  if (user.organization_name) return user.organization_name
  if (user.id) return `ID ${compactValue(user.id)}`
  return '后端未返回邮箱或用户名'
}

function parseMemoryEntries(content: string): MemoryEntry[] {
  return content
    .split(/\r?\n/)
    .map((line, index) => ({
      id: `memory-${index}`,
      text: line.replace(/^\s*[-*]\s+/, '').trim(),
    }))
    .filter(entry => entry.text.length > 0)
}

function serializeMemoryEntries(entries: MemoryEntry[]): string {
  return entries
    .map(entry => entry.text.trim())
    .filter(Boolean)
    .map(text => `- ${text}`)
    .join('\n')
}

function displayProjectName(projectPath: string, projects: ProjectEntry[], workspace: AppSnapshot['workspace']): string {
  const project = projects.find(item => item.path === projectPath)
  if (project?.name) return project.name
  if (workspace.path === projectPath && workspace.folder) return workspace.folder
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || workspace.folder || '当前项目'
}

function sessionProjectKey(projectPath: string, fallback: string): string {
  return projectPath.trim() || fallback
}

function normalizedSessionProjectKey(projectPath: string | null | undefined, fallback = 'default'): string {
  const normalized = (projectPath ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || fallback
}

function hasVisibleSessionMessages(messages: ChatMessage[] | undefined): boolean {
  return Boolean(messages?.some(message => message.role !== 'system' && message.content.trim()))
}

function isEmptyCurrentSession(session: Session): boolean {
  return isUntitledSession(session) && session.tokens <= 0 && session.context_used <= 0
}

function isUntitledSession(session: Session): boolean {
  const title = session.title.trim()
  return title === '' || title === '当前会话' || /^会话\s+\d+$/.test(title)
}

function sessionTitleFromPrompt(content: string, imageCount = 0): string {
  const cleaned = content
    .replace(/^请把以下内容作为当前目标持续推进直到完成：/, '')
    .replace(/^请先制定实施计划，不要直接修改文件：/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return imageCount > 0 ? `图片分析${imageCount > 1 ? ` ${imageCount} 张` : ''}` : '新对话'
  if (cleaned.startsWith('/')) return cleaned.slice(0, 36)
  return cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned
}

function hasSessionWork(session: Session, messagesBySession: Record<string, ChatMessage[]>): boolean {
  return (
    hasVisibleSessionMessages(messagesBySession[session.id]) ||
    session.tokens > 0 ||
    session.context_used > 0 ||
    !isEmptyCurrentSession(session)
  )
}

function pruneSessions(
  input: Session[],
  messagesBySession: Record<string, ChatMessage[]> = {},
  activeSessionId = '',
  keepEmptyCurrentPlaceholders = true,
): Session[] {
  const seen = new Set<string>()
  const projectsWithWork = new Set<string>()
  const emptyCurrentByProject = new Map<string, Session>()
  const emptyCurrentIds = new Set<string>()

  for (const session of input) {
    if (!session.id || seen.has(session.id)) continue
    seen.add(session.id)
    if (hasSessionWork(session, messagesBySession)) {
      projectsWithWork.add(normalizedSessionProjectKey(session.project_path))
    }
  }

  for (const session of input) {
    if (!session.id) continue
    if (!isEmptyCurrentSession(session) || hasSessionWork(session, messagesBySession)) continue

    const key = normalizedSessionProjectKey(session.project_path)
    if (projectsWithWork.has(key) && !(keepEmptyCurrentPlaceholders && session.id === activeSessionId)) continue
    const existing = emptyCurrentByProject.get(key)
    if (!existing || session.id === activeSessionId || existing.id !== activeSessionId) {
      emptyCurrentByProject.set(key, session)
    }
  }

  for (const session of emptyCurrentByProject.values()) {
    emptyCurrentIds.add(session.id)
  }

  return input
    .filter(session => {
      if (!session.id) return false
      if (hasSessionWork(session, messagesBySession)) return true
      return keepEmptyCurrentPlaceholders && emptyCurrentIds.has(session.id)
    })
    .filter((session, index, sessions) => sessions.findIndex(item => item.id === session.id) === index)
    .slice(0, MAX_STORED_SESSIONS)
}

function persistActiveProjectPath(projectPath: string) {
  try {
    if (projectPath === NO_PROJECT_SELECTION) {
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectPath)
    } else if (projectPath.trim()) {
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectPath)
    } else {
      window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY)
    }
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

function validStoredSession(value: unknown): Session | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<Session>
  if (typeof item.id !== 'string' || !item.id.trim()) return null
  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : '当前会话',
    tokens: typeof item.tokens === 'number' ? item.tokens : 0,
    context_used: typeof item.context_used === 'number' ? item.context_used : 0,
    context_limit: typeof item.context_limit === 'number' ? item.context_limit : 1_000_000,
    project_path: typeof item.project_path === 'string' ? item.project_path : '',
    remote: item.remote !== false,
  }
}

function sanitizeStoredMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<ChatMessage>
  if (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') return null
  const content = typeof item.content === 'string' ? item.content.slice(0, MAX_STORED_MESSAGE_CHARS) : ''
  if (/无法读取后端响应.*Resource temporarily unavailable.*os error 35/i.test(content)) return null
  const createdAt = typeof item.created_at === 'number' && Number.isFinite(item.created_at)
    ? item.created_at
    : undefined
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id : `m-${Date.now()}`,
    role: item.role,
    content,
    ...(createdAt ? { created_at: createdAt } : {}),
  }
}

function sanitizeStoredMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return []
  return messages
    .slice(-MAX_STORED_MESSAGES_PER_SESSION)
    .map(sanitizeStoredMessage)
    .filter((message): message is ChatMessage => Boolean(message))
}

function mergeSessions(...sessionLists: Session[][]): Session[] {
  const merged: Session[] = []
  const seen = new Set<string>()
  for (const list of sessionLists) {
    for (const session of list) {
      if (!session.id || seen.has(session.id)) continue
      seen.add(session.id)
      merged.push(session)
    }
  }
  const sessions = pruneSessions(merged)
  const realSessions = sessions.filter(session => session.id !== fallbackSnapshot.sessions[0].id)
  return realSessions.length > 0 ? realSessions : sessions
}

function readStoredConversationState(): StoredConversationState {
  try {
    const raw = window.localStorage.getItem(CONVERSATION_STORAGE_KEY)
    if (!raw) return { activeSessionId: '', sessions: [], messages: {} }
    const value = JSON.parse(raw) as Partial<StoredConversationState>
    const storedActiveSessionId = typeof value.activeSessionId === 'string' ? value.activeSessionId : ''
    const sessions = Array.isArray(value.sessions)
      ? value.sessions
          .map(validStoredSession)
          .filter((session): session is Session => Boolean(session))
          .slice(0, MAX_STORED_SESSIONS)
      : []
    const messages: Record<string, ChatMessage[]> = {}
    if (value.messages && typeof value.messages === 'object') {
      for (const [sessionId, sessionMessages] of Object.entries(value.messages)) {
        if (typeof sessionId !== 'string' || !sessionId.trim()) continue
        const sanitized = sanitizeStoredMessages(sessionMessages)
        if (sanitized.length > 0) messages[sessionId] = sanitized
      }
    }
    const cleanedSessions = pruneSessions(sessions, messages, storedActiveSessionId, false)
    return {
      activeSessionId: cleanedSessions.some(session => session.id === storedActiveSessionId)
        ? storedActiveSessionId
        : cleanedSessions[0]?.id ?? '',
      sessions: cleanedSessions,
      messages,
    }
  } catch {
    return { activeSessionId: '', sessions: [], messages: {} }
  }
}

function persistConversationState(input: StoredConversationState) {
  try {
    const messages: Record<string, ChatMessage[]> = {}
    for (const [sessionId, sessionMessages] of Object.entries(input.messages)) {
      const sanitized = sanitizeStoredMessages(sessionMessages)
      if (sanitized.length > 0) messages[sessionId] = sanitized
    }
    const sessions = pruneSessions(
      input.sessions
        .filter(session => session.id !== fallbackSnapshot.sessions[0].id),
      messages,
      input.activeSessionId,
      false,
    )
    const sessionIds = new Set(sessions.map(session => session.id))
    for (const sessionId of Object.keys(messages)) {
      if (!sessionIds.has(sessionId)) delete messages[sessionId]
    }
    window.localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify({
      activeSessionId: sessionIds.has(input.activeSessionId) ? input.activeSessionId : sessions[0]?.id ?? '',
      sessions,
      messages,
    }))
  } catch {
    // Keep persistence best-effort so storage quota never blocks chat.
  }
}

function readArchivedSessions(): ArchivedSessionEntry[] {
  try {
    const raw = window.localStorage.getItem(ARCHIVED_SESSIONS_STORAGE_KEY)
    if (!raw) return []
    const items = JSON.parse(raw)
    if (!Array.isArray(items)) return []
    return items.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const record = item as Partial<ArchivedSessionEntry>
      const session = validStoredSession(record.session)
      if (!session) return []
      return [{
        session,
        messages: sanitizeStoredMessages(record.messages),
        archivedAt: typeof record.archivedAt === 'number' ? record.archivedAt : Date.now(),
      }]
    })
  } catch {
    return []
  }
}

function persistArchivedSessions(entries: ArchivedSessionEntry[]) {
  try {
    window.localStorage.setItem(ARCHIVED_SESSIONS_STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_STORED_SESSIONS)))
  } catch {
    // Keep archive persistence best-effort.
  }
}

function compactValue(value: string | null | undefined): string {
  if (!value) return '未生成'
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}…${value.slice(-6)}`
}

function shortRevision(value: string | null | undefined): string {
  if (!value) return '未读取'
  return value.slice(0, 8)
}

function formatUpdateCheckedAt(value: number): string {
  if (!value) return '未检测'
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function imageAttachmentSrc(image: ImageAttachment): string {
  const data = image.data.includes(',') ? image.data.split(',').pop() ?? '' : image.data
  return `data:${image.media_type || 'image/png'};base64,${data}`
}

function messageCreatedAt(message: ChatMessage | undefined): number | null {
  const value = message?.created_at
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function shouldShowIdleDivider(messages: ChatMessage[], index: number): boolean {
  const current = messageCreatedAt(messages[index])
  if (!current) return false

  for (let prevIndex = index - 1; prevIndex >= 0; prevIndex -= 1) {
    const previous = messageCreatedAt(messages[prevIndex])
    if (previous) return current - previous >= LONG_IDLE_DIVIDER_MS
  }

  return false
}

function formatIdleDivider(timestamp: number | null): string {
  if (!timestamp) return '24 小时后'
  const date = new Date(timestamp)
  return `${date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

function isAuthExpiredMessage(value: string): boolean {
  return /401|Invalid Android token|登录已过期|令牌无效|重新登录/i.test(value)
}

function backendPermissionMode(value: PermissionMode): string {
  switch (value) {
    case 'auto-review':
      return 'acceptEdits'
    case 'full':
      return 'bypassPermissions'
    default:
      return 'default'
  }
}

function textFromStreamContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    return value.map(textFromStreamContent).filter(Boolean).join('')
  }
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string') return record.content
  if (Array.isArray(record.content)) return textFromStreamContent(record.content)
  return ''
}

function compactJsonValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function runtimeEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toolMessageId(toolUseId: string): string {
  return `tool-${toolUseId || runtimeEventId('unknown')}`
}

function thinkingChainMessageId(assistantId: string): string {
  return `thinking-chain-${assistantId}`
}

type ThinkingChainEvent = RuntimeEvent & {
  created_at: number
}

type ThinkingChainPayload = {
  started_at: number
  ended_at: number | null
  events: ThinkingChainEvent[]
}

const THINKING_CHAIN_PREFIX = '__spark_thinking_chain__:'

function serializeThinkingChain(payload: ThinkingChainPayload): string {
  return `${THINKING_CHAIN_PREFIX}${JSON.stringify(payload)}`
}

function parseThinkingChain(content: string): ThinkingChainPayload | null {
  if (!content.startsWith(THINKING_CHAIN_PREFIX)) return null
  try {
    const payload = JSON.parse(content.slice(THINKING_CHAIN_PREFIX.length)) as ThinkingChainPayload
    if (!payload || typeof payload.started_at !== 'number' || !Array.isArray(payload.events)) return null
    return {
      started_at: payload.started_at,
      ended_at: typeof payload.ended_at === 'number' ? payload.ended_at : null,
      events: payload.events,
    }
  } catch {
    return null
  }
}

function formatProcessingDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now()
  const seconds = Math.max(1, Math.round((end - startedAt) / 1000))
  return `${seconds} 秒`
}

function buildReviewDiff(beforeContent: string, afterContent: string): ReviewDiffRow[] {
  const before = beforeContent.split(/\r?\n/)
  const after = afterContent.split(/\r?\n/)
  if (before.at(-1) === '') before.pop()
  if (after.at(-1) === '') after.pop()

  const maxComparableLines = 650
  if (before.length * after.length > maxComparableLines * maxComparableLines) {
    return [
      ...before.map((text, index) => ({ type: 'removed' as const, oldLine: index + 1, newLine: null, text })),
      ...after.map((text, index) => ({ type: 'added' as const, oldLine: null, newLine: index + 1, text })),
    ].slice(0, 900)
  }

  const dp = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows: ReviewDiffRow[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({ type: 'same', oldLine: i + 1, newLine: j + 1, text: before[i] })
      i += 1
      j += 1
    } else if (j < after.length && (i >= before.length || dp[i][j + 1] >= dp[i + 1][j])) {
      rows.push({ type: 'added', oldLine: null, newLine: j + 1, text: after[j] })
      j += 1
    } else {
      rows.push({ type: 'removed', oldLine: i + 1, newLine: null, text: before[i] })
      i += 1
    }
  }
  return rows
}

function visibleReviewDiffRows(rows: ReviewDiffRow[], contextSize = 3): ReviewDiffRow[] {
  const changed = new Set<number>()
  rows.forEach((row, index) => {
    if (row.type === 'same') return
    for (let offset = -contextSize; offset <= contextSize; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < rows.length) changed.add(target)
    }
  })
  if (changed.size === 0) return rows.slice(0, 80)
  return rows.filter((_, index) => changed.has(index))
}

function toolInputTitle(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const record = input as Record<string, unknown>
  if (name === 'Bash' && typeof record.command === 'string') return record.command
  if (typeof record.command === 'string') return record.command
  if (typeof record.path === 'string') return `${name} ${record.path}`
  if (typeof record.file_path === 'string') return `${name} ${record.file_path}`
  if (typeof record.pattern === 'string') return `${name} ${record.pattern}`
  return name
}

function toolInputBody(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (name === 'Bash' && typeof record.command === 'string') return `$ ${record.command}`
  const compact = compactJsonValue(input)
  return compact ? `${name}\n${compact}` : name
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return compactJsonValue(value)
  if (Array.isArray(value)) {
    return value.map(toolResultText).filter(Boolean).join('\n')
  }
  const record = value as Record<string, unknown>
  if (typeof record.content === 'string') return record.content
  if (Array.isArray(record.content)) return toolResultText(record.content)
  if (typeof record.text === 'string') return record.text
  if (typeof record.stdout === 'string' || typeof record.stderr === 'string') {
    return [record.stdout, record.stderr].filter(value => typeof value === 'string' && value).join('\n')
  }
  return compactJsonValue(value)
}

function toolUseBlocksFromBackendMessage(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const event = record.type === 'event' && record.event && typeof record.event === 'object'
    ? record.event as Record<string, unknown>
    : record

  if (event.type === 'content_block_start') {
    const block = event.content_block && typeof event.content_block === 'object'
      ? event.content_block as Record<string, unknown>
      : null
    return block?.type === 'tool_use' ? [block] : []
  }

  const message = event.message && typeof event.message === 'object'
    ? event.message as Record<string, unknown>
    : event.type === 'assistant' ? event : null
  const content = Array.isArray(message?.content) ? message.content : []
  return content.filter(block =>
    block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use',
  ) as Record<string, unknown>[]
}

function toolResultBlocksFromBackendMessage(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const event = record.type === 'event' && record.event && typeof record.event === 'object'
    ? record.event as Record<string, unknown>
    : record

  const block = event.content_block && typeof event.content_block === 'object'
    ? event.content_block as Record<string, unknown>
    : null
  if (block?.type === 'tool_result') return [block]

  const message = event.message && typeof event.message === 'object'
    ? event.message as Record<string, unknown>
    : event.type === 'user' ? event : null
  const content = Array.isArray(message?.content) ? message.content : []
  return content.filter(item =>
    item && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_result',
  ) as Record<string, unknown>[]
}

function runtimeEventFromBackendMessage(value: unknown): RuntimeEvent | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''

  if (type === 'assistant') {
    const message = record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown>
      : null
    const content = message?.content
    const blocks = Array.isArray(content) ? content : []
    const toolUse = blocks.find(block =>
      block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use',
    ) as Record<string, unknown> | undefined
    if (toolUse) {
      const name = typeof toolUse.name === 'string' ? toolUse.name : '工具'
      const input = compactJsonValue(toolUse.input)
      return {
        id: runtimeEventId('tool'),
        label: '调用工具',
        value: input ? `${name} ${input.slice(0, 180)}` : name,
        tone: 'info',
      }
    }
    const text = textFromStreamContent(content).trim()
    if (text) {
      return {
        id: runtimeEventId('assistant'),
        label: '模型输出',
        value: text.slice(0, 180),
        tone: 'muted',
      }
    }
  }

  if (type === 'progress') {
    const progress = record.progress && typeof record.progress === 'object'
      ? record.progress as Record<string, unknown>
      : record.progress
    const valueText = compactJsonValue(progress || record.message || record)
    return {
      id: runtimeEventId('progress'),
      label: '工具进度',
      value: valueText.slice(0, 220) || '进行中',
      tone: 'info',
    }
  }

  if (type === 'stream_event') {
    return runtimeEventFromBackendMessage(record.event)
  }

  if (type === 'content_block_start') {
    const block = record.content_block && typeof record.content_block === 'object'
      ? record.content_block as Record<string, unknown>
      : null
    if (block?.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : '工具'
      return {
        id: runtimeEventId('tool-start'),
        label: '准备工具',
        value: name,
        tone: 'info',
      }
    }
  }

  if (type === 'message_start') {
    return {
      id: runtimeEventId('message-start'),
      label: '开始响应',
      value: '后端已收到请求',
      tone: 'info',
    }
  }

  if (type === 'message_stop') {
    return {
      id: runtimeEventId('message-stop'),
      label: '响应完成',
      value: '模型消息流结束',
      tone: 'success',
    }
  }

  if (type === 'system') {
    const message = typeof record.message === 'string' ? record.message : compactJsonValue(record)
    return {
      id: runtimeEventId('system'),
      label: '系统事件',
      value: message.slice(0, 180),
      tone: record.level === 'error' ? 'warning' : 'muted',
    }
  }

  if (type === 'tool_use_summary') {
    return {
      id: runtimeEventId('tool-summary'),
      label: '工具摘要',
      value: compactJsonValue(record).slice(0, 220),
      tone: 'success',
    }
  }

  return null
}

function permissionRequestFromBackendMessage(value: unknown): GuiPermissionRequest | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.type !== 'permission_request') return null
  const request = record.request
  if (!request || typeof request !== 'object') return null
  const item = request as Partial<GuiPermissionRequest>
  if (!item.id || !item.tool_name || !item.session_id) return null
  return {
    id: String(item.id),
    session_id: String(item.session_id),
    tool_use_id: typeof item.tool_use_id === 'string' ? item.tool_use_id : '',
    tool_name: String(item.tool_name),
    message: typeof item.message === 'string' ? item.message : `${item.tool_name} 需要权限`,
    description: typeof item.description === 'string' ? item.description : '',
    input: item.input,
    suggestions: Array.isArray(item.suggestions) ? item.suggestions : [],
    blocked_path: typeof item.blocked_path === 'string' ? item.blocked_path : null,
    created_at: typeof item.created_at === 'number' ? item.created_at : Date.now(),
  }
}

function compactPermissionInput(value: unknown): string {
  const text = compactJsonValue(value)
  return text.length > 220 ? `${text.slice(0, 220)}...` : text
}

function inlineMarkdownNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let lastIndex = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const start = match.index ?? 0
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start))

    if (value.startsWith('`')) {
      nodes.push(<code key={`${keyPrefix}-code-${index}`}>{value.slice(1, -1)}</code>)
    } else if (value.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-strong-${index}`}>{value.slice(2, -2)}</strong>)
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const href = link?.[2] ?? ''
      nodes.push(
        <a
          href={href}
          key={`${keyPrefix}-link-${index}`}
          rel="noreferrer"
          target="_blank"
        >
          {link?.[1] ?? value}
        </a>,
      )
    }
    lastIndex = start + value.length
    index += 1
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function renderMarkdownBlocks(content: string, keyPrefix: string): ReactNode {
  const blocks: ReactNode[] = []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let index = 0

  const pushParagraph = (paragraphLines: string[], blockIndex: number) => {
    const text = paragraphLines.join('\n').trimEnd()
    if (!text.trim()) return
    blocks.push(
      <p key={`${keyPrefix}-p-${blockIndex}`}>
        {text.split('\n').flatMap((line, lineIndex) => [
          ...(lineIndex > 0 ? [<br key={`${keyPrefix}-p-${blockIndex}-br-${lineIndex}`} />] : []),
          ...inlineMarkdownNodes(line, `${keyPrefix}-p-${blockIndex}-${lineIndex}`),
        ])}
      </p>,
    )
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (!trimmed) {
      index += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim()
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push(
        <pre className="markdown-code-block" key={`${keyPrefix}-codeblock-${index}`}>
          <code data-language={language || undefined}>{codeLines.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      const level = Math.min(heading[1].length + 2, 5)
      const headingContent = inlineMarkdownNodes(heading[2], `${keyPrefix}-heading-${index}`)
      blocks.push(level <= 3
        ? <h3 key={`${keyPrefix}-heading-${index}`}>{headingContent}</h3>
        : level === 4
          ? <h4 key={`${keyPrefix}-heading-${index}`}>{headingContent}</h4>
          : <h5 key={`${keyPrefix}-heading-${index}`}>{headingContent}</h5>)
      index += 1
      continue
    }

    const nextTrimmed = lines[index + 1]?.trim() ?? ''
    if (trimmed.includes('|') && nextTrimmed) {
      const headers = markdownTableCells(trimmed)
      const delimiters = markdownTableCells(nextTrimmed)
      if (
        headers.length >= 2 &&
        delimiters.length === headers.length &&
        delimiters.every(markdownTableDelimiterCell)
      ) {
        const alignments = delimiters.map(markdownTableAlignment)
        const rows: string[][] = []
        index += 2
        while (index < lines.length) {
          const current = lines[index] ?? ''
          const currentTrimmed = current.trim()
          if (!currentTrimmed || !currentTrimmed.includes('|')) break
          rows.push(markdownTableCells(current))
          index += 1
        }
        blocks.push(renderMarkdownTable(headers, rows, alignments, `${keyPrefix}-table-${index}`))
        continue
      }
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^[-*]\s+/, ''))
        index += 1
      }
      blocks.push(
        <ul key={`${keyPrefix}-ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${keyPrefix}-ul-${index}-${itemIndex}`}>
              {inlineMarkdownNodes(item, `${keyPrefix}-ul-${index}-${itemIndex}`)}
            </li>
          ))}
        </ul>,
      )
      continue
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^\d+\.\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^\d+\.\s+/, ''))
        index += 1
      }
      blocks.push(
        <ol key={`${keyPrefix}-ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${keyPrefix}-ol-${index}-${itemIndex}`}>
              {inlineMarkdownNodes(item, `${keyPrefix}-ol-${index}-${itemIndex}`)}
            </li>
          ))}
        </ol>,
      )
      continue
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[index] ?? '').trim().replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(
        <blockquote key={`${keyPrefix}-quote-${index}`}>
          {quoteLines.map((quoteLine, quoteIndex) => (
            <p key={`${keyPrefix}-quote-${index}-${quoteIndex}`}>
              {inlineMarkdownNodes(quoteLine, `${keyPrefix}-quote-${index}-${quoteIndex}`)}
            </p>
          ))}
        </blockquote>,
      )
      continue
    }

    const paragraphLines: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      const currentTrimmed = current.trim()
      if (
        !currentTrimmed ||
        currentTrimmed.startsWith('```') ||
        /^(#{1,4})\s+/.test(currentTrimmed) ||
        (currentTrimmed.includes('|') && markdownTableCells(lines[index + 1]?.trim() ?? '').some(markdownTableDelimiterCell)) ||
        /^[-*]\s+/.test(currentTrimmed) ||
        /^\d+\.\s+/.test(currentTrimmed) ||
        currentTrimmed.startsWith('>')
      ) {
        break
      }
      paragraphLines.push(current)
      index += 1
    }
    pushParagraph(paragraphLines, index)
  }

  return <div className="message-markdown">{blocks}</div>
}

function shouldRenderAsTerminal(message: ChatMessage): boolean {
  if (message.id.startsWith('local-')) return true
  if (message.id.startsWith('terminal-output-')) return true
  if (looksLikeTerminalOutput(message.content)) return true
  return /^(Spark Code (Doctor|Status|Stats)|原 TUI 后台任务列表)/.test(message.content.trim())
}

function shouldRenderAsExpandedTerminal(message: ChatMessage): boolean {
  return false
}

function orderedConversationMessages(messages: ChatMessage[]): ChatMessage[] {
  const ordered: ChatMessage[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const isAssistantAnswer =
      message.role === 'assistant' &&
      !shouldRenderAsTerminal(message) &&
      !parseThinkingChain(message.content)

    if (isAssistantAnswer) {
      const terminalMessages: ChatMessage[] = []
      let cursor = index + 1
      while (cursor < messages.length && shouldRenderAsTerminal(messages[cursor])) {
        terminalMessages.push(messages[cursor])
        cursor += 1
      }
      if (terminalMessages.length > 0) {
        ordered.push(...terminalMessages, message)
        index = cursor - 1
        continue
      }
    }

    ordered.push(message)
  }
  return ordered
}

function terminalResultTitle(content: string): string {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean)
  const commandLine = lines.find(line => line.startsWith('$ '))
  const running = lines.some(line => line === '正在执行...')
  const toolLine = lines[0] ?? ''
  if (/^(Read|Edit|Write|Bash|Grep|Glob|LS|TodoWrite|WebFetch|WebSearch)\b/.test(toolLine)) {
    const payload = lines[1] && lines[1].startsWith('{') ? ` ${lines[1]}` : ''
    return `${running ? '正在调用' : '已调用'} ${toolLine}${payload}`
  }
  if (!commandLine) return running ? '正在调用 工具' : '已调用 工具'
  const command = commandLine.slice(2).replace(/\s+/g, ' ').trim() || '未知指令'
  return `${running ? '正在调用' : '已调用'} Bash ${command}`
}

function terminalResultBody(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim().startsWith('$ ')) {
    const nextLines = lines.slice(1)
    while (nextLines[0]?.trim() === '') {
      nextLines.shift()
    }
    return nextLines.join('\n') || '指令已执行'
  }
  return content
}

function looksLikeTerminalOutput(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length < 4) return false
  if (lines.some(line => line.startsWith('$ '))) return true
  if (/^(Read|Edit|Write|Bash|Grep|Glob|LS|TodoWrite|WebFetch|WebSearch)\b/.test(lines[0] ?? '')) return true

  const absolutePathLines = lines.filter(line =>
    /^\/Users\/[^ ]+/.test(line) ||
    /^\/(Applications|System|Library|Volumes|tmp|var|opt|usr)\//.test(line),
  )
  if (absolutePathLines.length >= 3) return true

  const gitLogLines = lines.filter(line => /^[a-f0-9]{7,40}\s+\S+/.test(line))
  if (gitLogLines.length >= 3) return true

  const fileLikeLines = lines.filter(line =>
    /^[\w@./~:+ -]+$/.test(line) &&
    (
      /[./]/.test(line) ||
      /\.(ts|tsx|js|jsx|json|md|css|scss|html|rs|toml|lock|ya?ml|dart|swift|kt|java|py|go|sh|png|ico)$/.test(line)
    ),
  )
  return fileLikeLines.length >= 5 && fileLikeLines.length / lines.length >= 0.55
}

function looksLikeToolOnlyOutput(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length < 6) return false
  const listingLines = lines.filter(line =>
    /^[\w@./~:+-]+$/.test(line) ||
    /^[\w@./~:+-]+\.(ts|tsx|js|jsx|json|md|css|scss|html|rs|toml|lock|yml|yaml)$/.test(line)
  )
  return listingLines.length / lines.length >= 0.8
}

function markdownTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
}

function markdownTableDelimiterCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim())
}

function markdownTableAlignment(cell: string): 'left' | 'center' | 'right' | null {
  const trimmed = cell.trim()
  const left = trimmed.startsWith(':')
  const right = trimmed.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

function renderMarkdownTable(
  headers: string[],
  rows: string[][],
  alignments: Array<'left' | 'center' | 'right' | null>,
  keyPrefix: string,
): ReactNode {
  return (
    <div className="markdown-table-wrap" key={`${keyPrefix}-table-wrap`}>
      <table className="markdown-table">
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th key={`${keyPrefix}-th-${index}`} style={{ textAlign: alignments[index] ?? 'left' }}>
                {inlineMarkdownNodes(header, `${keyPrefix}-th-${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${keyPrefix}-tr-${rowIndex}`}>
              {headers.map((_, cellIndex) => (
                <td key={`${keyPrefix}-td-${rowIndex}-${cellIndex}`} style={{ textAlign: alignments[cellIndex] ?? 'left' }}>
                  {inlineMarkdownNodes(row[cellIndex] ?? '', `${keyPrefix}-td-${rowIndex}-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function renderMessageContent(message: ChatMessage, thinking: boolean): ReactNode {
  const thinkingChain = parseThinkingChain(message.content)
  if (thinkingChain) {
    const done = Boolean(thinkingChain.ended_at)
    return (
      <details className="thinking-chain" open={!done}>
        <summary>
          <BrainCircuit size={15} aria-hidden="true" />
          <span>{done ? `已处理 ${formatProcessingDuration(thinkingChain.started_at, thinkingChain.ended_at)}` : '正在处理'}</span>
        </summary>
        <div className="thinking-chain-list">
          {thinkingChain.events.length > 0 ? (
            thinkingChain.events.map(event => (
              <article className={`runtime-event ${event.tone}`} key={event.id}>
                <span>{event.label}</span>
                <p>{event.value}</p>
              </article>
            ))
          ) : (
            <div className="empty-compact">等待后端事件</div>
          )}
        </div>
      </details>
    )
  }
  if (thinking) return <p className="thinking-text">{message.content || '正在思考'}</p>
  if (shouldRenderAsTerminal(message)) {
    if (shouldRenderAsExpandedTerminal(message)) {
      return (
        <div className="terminal-result expanded compact" role="group" aria-label="工具输出">
          <div className="terminal-result-header">
            <TerminalSquare size={14} aria-hidden="true" />
            <span>工具输出</span>
          </div>
          <div className="terminal-result-body">
            <pre>{message.content}</pre>
          </div>
        </div>
      )
    }
    return (
      <details className="terminal-result" role="group" aria-label="指令执行结果">
        <summary className="terminal-result-header">
          <TerminalSquare size={14} aria-hidden="true" />
          <span>{terminalResultTitle(message.content)}</span>
        </summary>
        <div className="terminal-result-body">
          <pre>{terminalResultBody(message.content)}</pre>
        </div>
      </details>
    )
  }
  return renderMarkdownBlocks(message.content, message.id)
}

function streamTextUpdate(value: unknown): { text: string; mode: 'append' | 'replace' } | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const event = (record.event && typeof record.event === 'object')
    ? record.event as Record<string, unknown>
    : record
  const delta = (event.delta && typeof event.delta === 'object')
    ? event.delta as Record<string, unknown>
    : null
  const deltaText = typeof delta?.text === 'string' ? delta.text : ''
  if (deltaText) return { text: deltaText, mode: 'append' }

  const message = (record.message && typeof record.message === 'object')
    ? record.message as Record<string, unknown>
    : null
  const messageText = textFromStreamContent(message?.content)
  if (messageText) return { text: messageText, mode: 'replace' }

  const contentText = textFromStreamContent(record.content)
  if (contentText) return { text: contentText, mode: 'replace' }
  if (typeof record.result === 'string') return { text: record.result, mode: 'replace' }
  return null
}

class StreamPromptError extends Error {
  backendError: boolean
  retryExhausted: boolean

  constructor(message: string, backendError: boolean, retryExhausted = false) {
    super(message)
    this.name = 'StreamPromptError'
    this.backendError = backendError
    this.retryExhausted = retryExhausted
  }
}

function parseSseDataFrame(frame: string): unknown | null {
  const data = frame
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (!data) return null
  return JSON.parse(data)
}

const permissionOptions: Array<{
  id: PermissionMode
  label: string
  description: string
}> = [
  {
    id: 'limited',
    label: '有限',
    description: '操作前保持确认',
  },
  {
    id: 'auto-review',
    label: '自动审查',
    description: '自动接受低风险编辑',
  },
  {
    id: 'full',
    label: '完全权限',
    description: '跳过本地权限确认',
  },
]

function permissionLabel(mode: PermissionMode): string {
  return permissionOptions.find(option => option.id === mode)?.label ?? '有限'
}

function sourceLabel(source: string): string {
  if (source === 'codex') return '~/.codex'
  if (source === 'claude') return '~/.claude'
  return source
}

function toolSourceLabel(tool: ToolEntry): string {
  if (tool.source === 'builtin') return '内置'
  if (tool.source === 'mcp') return tool.mcp_server ? `MCP · ${tool.mcp_server}` : 'MCP'
  if (tool.source === 'lsp') return 'LSP'
  return tool.source
}

function toolReadModeLabel(tool: ToolEntry): string {
  if (tool.read_only === true) return '只读'
  if (tool.read_only === false) return '可写'
  return '动态'
}

function formatChangeTime(value: string): string {
  const numeric = Number(value)
  const date = Number.isFinite(numeric) && value.trim() ? new Date(numeric) : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatFileSize(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`
  return `${Math.round(value / 1024 / 102.4) / 10} MB`
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized || !normalized.includes('/')) return ''
  return normalized.split('/').slice(0, -1).join('/')
}

function isSafeProjectRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').trim()
  if (!normalized || normalized.startsWith('/')) return false
  return normalized
    .split('/')
    .filter(Boolean)
    .every(part => part !== '.' && part !== '..')
}

function parseSlashCommand(value: string): { name: string; args: string } | null {
  const match = value.trim().match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return {
    name: match[1].toLowerCase(),
    args: match[2]?.trim() ?? '',
  }
}

function findActiveFileMention(value: string, cursor: number): { start: number; end: number; query: string } | null {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
  if (!match || match.index === undefined) return null
  const prefix = match[1] ?? ''
  const start = match.index + prefix.length
  return {
    start,
    end: cursor,
    query: match[2] ?? '',
  }
}

function fileMentionRanges(value: string): Array<{ start: number; end: number; text: string }> {
  return Array.from(value.matchAll(/(^|\s)(@[^\s@]+)/g)).map(match => {
    const prefix = match[1] ?? ''
    const start = (match.index ?? 0) + prefix.length
    const text = match[2] ?? ''
    return {
      start,
      end: start + text.length,
      text,
    }
  })
}

type DroppedFile = File & {
  path?: string
  webkitRelativePath?: string
}

type FileMentionPathResult = {
  paths: string[]
  unresolved: number
}

function normalizeMentionPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim()
}

function projectRelativeMentionPath(rawPath: string, projectPath: string, fallback: string): string {
  const normalized = normalizeMentionPath(rawPath || fallback)
  const normalizedProject = normalizeMentionPath(projectPath)

  if (normalizedProject && normalized.startsWith(`${normalizedProject}/`)) {
    return normalized.slice(normalizedProject.length + 1) || fallback
  }

  return normalized || fallback
}

function nativeFilePath(file: File): string {
  const dropped = file as DroppedFile
  return dropped.path || dropped.webkitRelativePath || ''
}

function pathBasename(path: string): string {
  return normalizeMentionPath(path).split('/').filter(Boolean).pop() ?? path
}

function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>()
  return files.filter(file => {
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function clipboardFiles(data: DataTransfer): File[] {
  const itemFiles = Array.from(data.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => Boolean(file))

  return dedupeFiles([...Array.from(data.files ?? []), ...itemFiles])
}

function fileUrlToPath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith('file://')) return trimmed.startsWith('/') ? trimmed : null

  const withoutScheme = trimmed
    .replace(/^file:\/\/localhost/i, '')
    .replace(/^file:\/\//i, '')
  try {
    return decodeURIComponent(withoutScheme)
  } catch {
    return withoutScheme
  }
}

function clipboardTextFilePaths(data: DataTransfer): string[] {
  const values = ['text/uri-list', 'text/plain']
    .map(type => data.getData(type))
    .filter(Boolean)
  const paths = values.flatMap(value =>
    value
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(fileUrlToPath)
      .filter((path): path is string => Boolean(path)),
  )
  return Array.from(new Set(paths))
}

function clipboardLooksLikeFilePaste(data: DataTransfer): boolean {
  return Array.from(data.types ?? []).some(type =>
    /files|file-url|filenamespboardtype|uri-list/i.test(type),
  )
}

function imageAttachmentName(file: File, index: number): string {
  if (file.name.trim()) return file.name
  const subtype = file.type.split('/')[1]?.replace(/[^a-z0-9]+/gi, '') || 'png'
  return `粘贴图片-${index + 1}.${subtype}`
}

function fileMentionPathsForFiles(
  files: File[],
  projectPath: string,
  nativePaths: string[] = [],
): FileMentionPathResult {
  const availableNativePaths = [...nativePaths]
  let unresolved = 0

  const paths = files.map(file => {
    const directPath = nativeFilePath(file)
    const matchIndex = availableNativePaths.findIndex(path => pathBasename(path) === file.name)
    const matchedPath = matchIndex >= 0
      ? availableNativePaths.splice(matchIndex, 1)[0]
      : undefined
    const sameOrderPath = availableNativePaths.length === files.length
      ? availableNativePaths.shift()
      : undefined
    const rawPath = directPath || matchedPath || sameOrderPath

    if (!rawPath) unresolved += 1
    return projectRelativeMentionPath(rawPath || file.name, projectPath, file.name)
  })

  return { paths, unresolved }
}

function isTauriInvoke(value: unknown): value is TauriInvoke {
  return typeof value === 'function'
}

async function resolveTauriInvoke(): Promise<TauriInvoke> {
  try {
    const module = await import('@tauri-apps/api/core')
    if (isTauriInvoke(module.invoke)) {
      return module.invoke as TauriInvoke
    }
  } catch {
    // Fall through to the injected global bridge when available.
  }

  const bridge = window as TauriBridgeWindow
  const injectedInvoke =
    bridge.__TAURI_INTERNALS__?.invoke ??
    bridge.__TAURI__?.core?.invoke ??
    bridge.__TAURI__?.invoke

  if (isTauriInvoke(injectedInvoke)) {
    return injectedInvoke
  }

  throw new Error(TAURI_INVOKE_UNAVAILABLE_MESSAGE)
}

async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    const invoke = await resolveTauriInvoke()
    return await invoke<T>(command, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/undefined.*invoke|reading 'invoke'|__TAURI__|__TAURI_INTERNALS__/i.test(message)) {
      throw new Error(TAURI_INVOKE_UNAVAILABLE_MESSAGE)
    }
    throw error
  }
}

function SettingToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="setting-toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
        type="checkbox"
      />
      <i aria-hidden="true" />
    </label>
  )
}

function App() {
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null)
  const conversationEndRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToConversationBottomRef = useRef(true)
  const conversationScrollHandlesRef = useRef<{ rafs: number[]; timers: number[] }>({
    rafs: [],
    timers: [],
  })
  const creatingSessionRef = useRef(false)
  const modelSyncRetryRef = useRef(0)
  const [initialConversationState] = useState(readStoredConversationState)
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() => ({
    ...fallbackSnapshot,
    sessions: mergeSessions(initialConversationState.sessions, fallbackSnapshot.sessions),
  }))
  const [activeSessionId, setActiveSessionId] = useState(
    initialConversationState.activeSessionId ||
      initialConversationState.sessions[0]?.id ||
      fallbackSnapshot.sessions[0].id,
  )
  const [activeView, setActiveView] = useState<AppView>('chat')
  const [centerPanel, setCenterPanel] = useState<CenterPanel>('conversation')
  const [activeProjectPath, setActiveProjectPath] = useState(() => {
    try {
      return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [reviewOpen, setReviewOpen] = useState(false)
  const [selectedReviewChangeId, setSelectedReviewChangeId] = useState<string | null>(null)
  const [reviewDiff, setReviewDiff] = useState<ReviewDiffState | null>(null)
  const [isLoadingReviewDiff, setIsLoadingReviewDiff] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [settingsQuery, setSettingsQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [toolMenuOpen, setToolMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')
  const [sessionListCollapsed, setSessionListCollapsed] = useState(false)
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState<Set<string>>(() => new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>(
    initialConversationState.messages,
  )
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionEntry[]>(readArchivedSessions)
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([])
  const [queuePanelOpen, setQueuePanelOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [promptCursor, setPromptCursor] = useState(0)
  const [planModeEnabled, setPlanModeEnabled] = useState(false)
  const [goalModeEnabled, setGoalModeEnabled] = useState(false)
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [fileSuggestions, setFileSuggestions] = useState<ProjectFileEntry[]>([])
  const [activeFileSuggestionIndex, setActiveFileSuggestionIndex] = useState(0)
  const [directoryPath, setDirectoryPath] = useState('')
  const [directoryEntries, setDirectoryEntries] = useState<ProjectDirectoryEntry[]>([])
  const [activeFileDocument, setActiveFileDocument] = useState<ProjectFileDocument | null>(null)
  const [fileDraft, setFileDraft] = useState('')
  const [isLoadingDirectory, setIsLoadingDirectory] = useState(false)
  const [isLoadingFileDocument, setIsLoadingFileDocument] = useState(false)
  const [isSavingFileDocument, setIsSavingFileDocument] = useState(false)
  const [isComposerDragging, setIsComposerDragging] = useState(false)
  const [remoteBindCode, setRemoteBindCode] = useState('')
  const [activeSlashCommandIndex, setActiveSlashCommandIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [snapshotReady, setSnapshotReady] = useState(false)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const [isSavingModel, setIsSavingModel] = useState(false)
  const [isSavingPreferences, setIsSavingPreferences] = useState(false)
  const [isBindingRemoteDevice, setIsBindingRemoteDevice] = useState(false)
  const [isStartingLogin, setIsStartingLogin] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [revertingChangeId, setRevertingChangeId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [changeNotice, setChangeNotice] = useState<string | null>(null)
  const [modelSyncError, setModelSyncError] = useState<string | null>(null)
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([])
  const [pendingPermissions, setPendingPermissions] = useState<GuiPermissionRequest[]>([])
  const [respondingPermissionIds, setRespondingPermissionIds] = useState<Set<string>>(() => new Set())
  const [isLoadingTools, setIsLoadingTools] = useState(false)
  const [isRefreshingBackend, setIsRefreshingBackend] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(fallbackSnapshot.update_status)
  const [dismissedUpdateRevision, setDismissedUpdateRevision] = useState<string | null>(null)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [memoryDocument, setMemoryDocument] = useState<MemoryDocument | null>(null)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([])
  const [isLoadingMemory, setIsLoadingMemory] = useState(false)
  const [isSavingMemory, setIsSavingMemory] = useState(false)
  const [uiDensity, setUiDensity] = useState<'compact' | 'comfortable'>(() => {
    try {
      return window.localStorage.getItem(UI_DENSITY_STORAGE_KEY) === 'comfortable' ? 'comfortable' : 'compact'
    } catch {
      return 'compact'
    }
  })

  async function refreshSnapshot() {
    try {
      await safeInvoke<BackendRuntime>('ensure_local_backend').catch(() => null)
      const next = await safeInvoke<AppSnapshot>('get_app_snapshot')
      setSnapshot(current => ({
        ...next,
        sessions: mergeSessions(next.sessions, current.sessions),
      }))
      setUpdateStatus(next.update_status)
      setActiveProjectPath(current => {
        if (current && current !== fallbackSnapshot.workspace.path) return current
        return next.workspace.path
      })
    } finally {
      setSnapshotReady(true)
    }
  }

  async function refreshBackendRuntime() {
    setIsRefreshingBackend(true)
    setNotice(null)
    try {
      await refreshSnapshot()
      setNotice('本地后端状态已刷新')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsRefreshingBackend(false)
    }
  }

  async function syncActiveProjectToBackend(projectPath: string) {
    await safeInvoke<string | null>('set_active_project_path', {
      projectPath,
    }).catch(() => null)
  }

  async function refreshSlashCommands(projectPath: string) {
    if (projectPath === NO_PROJECT_SELECTION) return
    if (!projectPath.trim()) return
    const slashCommands = await safeInvoke<SlashCommandEntry[]>('get_slash_commands', {
      projectPath,
    })
    setSnapshot(current => ({ ...current, slash_commands: slashCommands }))
  }

  async function refreshToolCatalog(permissionMode: PermissionMode = snapshot.preferences.permission_mode) {
    setIsLoadingTools(true)
    try {
      const tools = await safeInvoke<ToolEntry[]>('get_tool_catalog', {
        permissionMode,
      })
      setSnapshot(current => ({ ...current, tools }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingTools(false)
    }
  }

  async function checkForUpdates(manual = false) {
    if (manual) setIsCheckingUpdate(true)
    try {
      const status = await safeInvoke<UpdateStatus>('check_app_update')
      setUpdateStatus(status)
      if (manual) {
        setNotice(status.update_available ? '检测到 Spark Code 有更新' : status.error ?? '当前已经是最新版本')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setUpdateStatus(current => ({
        ...current,
        checked_at: Date.now(),
        error: message,
        detail: '更新检测失败',
        update_available: false,
      }))
      if (manual) setNotice(message)
    } finally {
      if (manual) setIsCheckingUpdate(false)
    }
  }

  async function refreshModelConfig() {
    setIsLoadingModelConfig(true)
    setModelSyncError(null)
    try {
      const model = await safeInvoke<ModelConfig>('get_model_config')
      setSnapshot(current => ({ ...current, model }))
      if (model.options.length > 0) {
        modelSyncRetryRef.current = 0
      } else if (modelSyncRetryRef.current < 3) {
        modelSyncRetryRef.current += 1
        window.setTimeout(() => {
          refreshModelConfig().catch(() => {})
        }, 1_200)
      }
    } catch (error) {
      setModelSyncError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingModelConfig(false)
    }
  }

  useEffect(() => {
    refreshSnapshot().catch(() => {})
  }, [])

  useEffect(() => {
    const projectPath = activeProjectPath === NO_PROJECT_SELECTION ? '' : activeProjectPath
    void syncActiveProjectToBackend(projectPath)
  }, [activeProjectPath])

  useEffect(() => {
    refreshSlashCommands(activeProjectPath).catch(() => {})
  }, [activeProjectPath])

	  useEffect(() => {
	    if (activeView !== 'chat') {
	      setReviewOpen(false)
	    }
	  }, [activeView])

  useEffect(() => {
    if (activeView === 'settings') {
      workspaceBodyRef.current?.focus()
      void refreshMemoryDocument()
    }
  }, [activeView])

  useEffect(() => {
    refreshModelConfig().catch(() => {})
  }, [])

  useEffect(() => {
    void checkForUpdates()
    const interval = window.setInterval(() => {
      void checkForUpdates()
    }, UPDATE_POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    function closeFloatingUi() {
      setContextMenu(null)
      setToolMenuOpen(false)
      setPermissionMenuOpen(false)
      setModelMenuOpen(false)
      setProjectMenuOpen(false)
      setModeMenuOpen(false)
      setBranchMenuOpen(false)
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setSearchOpen(false)
        closeFloatingUi()
      }
    }

    window.addEventListener('click', closeFloatingUi)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('click', closeFloatingUi)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const sessions = useMemo(() => {
    return pruneSessions(snapshot.sessions, messagesBySession, activeSessionId, true)
  }, [activeSessionId, messagesBySession, snapshot.sessions])
  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) ?? sessions[0] ?? fallbackSnapshot.sessions[0],
    [activeSessionId, sessions],
  )
  const messages = messagesBySession[activeSession.id] ?? []
  const visibleMessages = messages.filter(message => message.role !== 'system')
  const lastVisibleMessage = visibleMessages[visibleMessages.length - 1]
  const lastVisibleMessageContent = lastVisibleMessage?.content ?? ''

  function conversationScrollElement(): HTMLElement | null {
    const body = workspaceBodyRef.current
    if (!body) return null
    if (body.scrollHeight > body.clientHeight + 1) return body
    const candidates = Array.from(body.querySelectorAll<HTMLElement>('*'))
    return candidates.find(element => element.scrollHeight > element.clientHeight + 1) ?? body
  }

  function conversationScrollElements(): HTMLElement[] {
    const body = workspaceBodyRef.current
    if (!body) return []
    return [body, ...Array.from(body.querySelectorAll<HTMLElement>('*'))]
      .filter((element, index, elements) =>
        elements.indexOf(element) === index && element.scrollHeight > element.clientHeight + 1,
      )
  }

  function clearScheduledConversationScroll() {
    conversationScrollHandlesRef.current.rafs.forEach(handle => window.cancelAnimationFrame(handle))
    conversationScrollHandlesRef.current.timers.forEach(handle => window.clearTimeout(handle))
    conversationScrollHandlesRef.current = { rafs: [], timers: [] }
  }

  function scrollConversationToBottom(behavior: ScrollBehavior = 'auto') {
    if (activeView !== 'chat' || centerPanel !== 'conversation') return
    clearScheduledConversationScroll()
    shouldStickToConversationBottomRef.current = true

    const scrollNow = (scrollBehavior: ScrollBehavior = behavior) => {
      const elements = conversationScrollElements()
      if (elements.length > 0) {
        for (const element of elements) {
          const bottom = Math.max(0, element.scrollHeight - element.clientHeight)
          element.scrollTo({ top: bottom, behavior: scrollBehavior })
          if (scrollBehavior === 'auto') element.scrollTop = bottom
        }
        return
      }
      conversationEndRef.current?.scrollIntoView({ block: 'end', inline: 'nearest', behavior: scrollBehavior })
    }

    scrollNow()

    const raf = window.requestAnimationFrame(() => {
      scrollNow()
      const nestedRaf = window.requestAnimationFrame(() => scrollNow())
      conversationScrollHandlesRef.current.rafs.push(nestedRaf)
    })
    const shortTimer = window.setTimeout(() => scrollNow('auto'), 80)
    const layoutTimer = window.setTimeout(() => scrollNow('auto'), 220)
    const lateLayoutTimer = window.setTimeout(() => scrollNow('auto'), 520)
    const settledTimer = window.setTimeout(() => scrollNow('auto'), 1200)
    conversationScrollHandlesRef.current = {
      rafs: [raf],
      timers: [shortTimer, layoutTimer, lateLayoutTimer, settledTimer],
    }
  }

  useLayoutEffect(() => {
    scrollConversationToBottom('auto')
  }, [activeSession.id, activeView, centerPanel, visibleMessages.length, lastVisibleMessageContent, streamingMessageId, isSending])

  useEffect(() => {
    if (activeView !== 'chat' || centerPanel !== 'conversation') return undefined
    const startedAt = Date.now()
    const interval = window.setInterval(() => {
      if (Date.now() - startedAt > 1800) {
        window.clearInterval(interval)
        return
      }
      scrollConversationToBottom('auto')
    }, 120)
    return () => window.clearInterval(interval)
  }, [activeSession.id, visibleMessages.length, lastVisibleMessageContent, streamingMessageId, isSending, activeView, centerPanel])

  useEffect(() => {
    return () => clearScheduledConversationScroll()
  }, [])

  useEffect(() => {
    const body = workspaceBodyRef.current
    if (!body) return undefined

    function handleScroll() {
      if (activeView !== 'chat' || centerPanel !== 'conversation') return
      const body = conversationScrollElement()
      if (!body) return
      const distanceFromBottom = body.scrollHeight - body.clientHeight - body.scrollTop
      shouldStickToConversationBottomRef.current = distanceFromBottom < 96
    }

    body.addEventListener('scroll', handleScroll, { passive: true })
    return () => body.removeEventListener('scroll', handleScroll)
  }, [activeView, centerPanel])

  useEffect(() => {
    if (activeView !== 'chat' || centerPanel !== 'conversation') return undefined
    const body = workspaceBodyRef.current
    if (!body || typeof ResizeObserver === 'undefined') return undefined

    const observer = new ResizeObserver(() => {
      if (shouldStickToConversationBottomRef.current) {
        scrollConversationToBottom('auto')
      }
    })
    observer.observe(body)
    const stream = body.querySelector('.conversation-stream')
    if (stream) observer.observe(stream)
    return () => observer.disconnect()
  }, [activeSession.id, activeView, centerPanel])

  useEffect(() => {
    const baseUrl = snapshot.backend_runtime.local_url?.trim().replace(/\/+$/, '')
    if (!baseUrl) return undefined

    let cancelled = false
    async function pollPendingPermissions() {
      try {
        const response = await fetch(`${baseUrl}/permissions/pending`, {
          headers: {
            authorization: `Bearer ${snapshot.backend_runtime.auth_token}`,
          },
        })
        if (!response.ok) return
        const requests = await response.json() as GuiPermissionRequest[]
        if (cancelled || !Array.isArray(requests)) return
        setPendingPermissions(requests.slice(-8))
      } catch {
        // SSE is the primary path; polling is only a quiet fallback.
      }
    }

    void pollPendingPermissions()
    const interval = window.setInterval(() => {
      void pollPendingPermissions()
    }, 1_500)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [snapshot.backend_runtime.auth_token, snapshot.backend_runtime.local_url])

  function setSessionMessages(sessionId: string, updater: (current: ChatMessage[]) => ChatMessage[]) {
    setMessagesBySession(current => ({
      ...current,
      [sessionId]: updater(current[sessionId] ?? []),
    }))
  }
  function setMessages(updater: (current: ChatMessage[]) => ChatMessage[]) {
    setSessionMessages(activeSession.id, updater)
  }
  const recentChanges = snapshot.recent_changes ?? []
  const sparkUser = snapshot.spark_user
  const remoteDevice = snapshot.remote_device
  const preferences = snapshot.preferences
  const workspace = snapshot.workspace
  const projects = snapshot.projects ?? []
  const skills = snapshot.skills ?? []
  const mcpServers = snapshot.mcp_servers ?? []
  const tools = snapshot.tools ?? []
  const builtinToolCount = tools.filter(tool => tool.source === 'builtin').length
  const enabledMcpServerCount = mcpServers.filter(server => server.enabled).length
  const settingsGroups = useMemo<Array<{ title: string; items: Array<{ id: SettingsSection; label: string; icon: ReactNode }> }>>(() => [
    {
      title: '个人',
      items: [
        { id: 'general', label: '常规', icon: <Settings2 size={19} aria-hidden="true" /> },
        { id: 'appearance', label: '外观', icon: <Sun size={19} aria-hidden="true" /> },
        { id: 'profile', label: '配置', icon: <ShieldCheck size={19} aria-hidden="true" /> },
        { id: 'personalization', label: '个性化', icon: <Sparkles size={19} aria-hidden="true" /> },
      ],
    },
    {
      title: '集成',
      items: [
        { id: 'tools', label: '工具', icon: <Cpu size={19} aria-hidden="true" /> },
        { id: 'remote', label: '远程控制', icon: <Network size={19} aria-hidden="true" /> },
      ],
    },
    {
      title: '编码',
      items: [
        { id: 'environment', label: '环境', icon: <TerminalSquare size={19} aria-hidden="true" /> },
        { id: 'worktree', label: '工作树', icon: <FolderTree size={19} aria-hidden="true" /> },
      ],
    },
    {
      title: '已归档',
      items: [
        { id: 'archived', label: '已归档对话', icon: <Archive size={19} aria-hidden="true" /> },
      ],
    },
  ], [])
  const availableSettingsSections = useMemo(
    () => new Set(settingsGroups.flatMap(group => group.items.map(item => item.id))),
    [settingsGroups],
  )
  const activeSettingsSection = availableSettingsSections.has(settingsSection) ? settingsSection : 'general'
  const visibleSettingsGroups = useMemo(() => {
    const normalizedSettingsQuery = settingsQuery.trim().toLowerCase()
    return settingsGroups
      .map(group => ({
        ...group,
        items: normalizedSettingsQuery
          ? group.items.filter(item => item.label.toLowerCase().includes(normalizedSettingsQuery))
          : group.items,
      }))
      .filter(group => group.items.length > 0)
  }, [settingsGroups, settingsQuery])
  useEffect(() => {
    if (!availableSettingsSections.has(settingsSection)) {
      setSettingsSection('general')
    }
  }, [availableSettingsSections, settingsSection])
  const slashCommands = useMemo(() => {
    return [...(snapshot.slash_commands ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  }, [snapshot.slash_commands])
  const backendRuntime = snapshot.backend_runtime
  const modelOptions = snapshot.model.options
  const selectedModel = modelOptions.find(option => option.id === snapshot.model.selected) ?? null
  const hasModelOptions = modelOptions.length > 0
  const modelSelectValue = selectedModel?.id ?? (hasModelOptions ? modelOptions[0].id : snapshot.model.selected)
  const noProjectSelected = activeProjectPath === NO_PROJECT_SELECTION
  const activeProjectPathForRequest = noProjectSelected
    ? ''
    : activeProjectPath || activeSession.project_path || workspace.path
  const activeProjectEntry = projects.find(project => project.path === activeProjectPathForRequest) ?? null
  const activeProjectName = noProjectSelected
    ? '不使用项目'
    : displayProjectName(activeProjectPathForRequest, projects, workspace)
  const activeProjectGitBranch =
    activeProjectEntry?.git_branch ??
    (workspace.path === activeProjectPathForRequest ? workspace.git_branch : null)
  const activeProjectMode = goalModeEnabled
    ? '目标模式'
    : planModeEnabled
      ? '计划模式'
      : (workspace.path === activeProjectPathForRequest ? workspace.mode : '编写模式')
  const projectOptions = useMemo(() => {
    const entries = new Map<string, ProjectEntry>()
    const addProject = (project: ProjectEntry | null) => {
      const path = project?.path.trim()
      if (!project || !path || entries.has(path)) return
      entries.set(path, {
        ...project,
        path,
        name: project.name || displayProjectName(path, projects, workspace),
      })
    }

    projects.forEach(addProject)
    addProject({
      id: workspace.path,
      name: workspace.folder,
      path: workspace.path,
      git_branch: workspace.git_branch,
      trust_level: null,
    })
    addProject({
      id: activeProjectPathForRequest,
      name: activeProjectName,
      path: activeProjectPathForRequest,
      git_branch: activeProjectGitBranch,
      trust_level: activeProjectEntry?.trust_level ?? null,
    })

    return Array.from(entries.values())
  }, [activeProjectEntry?.trust_level, activeProjectGitBranch, activeProjectName, activeProjectPathForRequest, projects, workspace])
  const filteredProjectOptions = useMemo(() => {
    const normalized = projectSearch.trim().toLowerCase()
    if (!normalized) return projectOptions.slice(0, 8)
    return projectOptions
      .filter(project =>
        project.name.toLowerCase().includes(normalized) ||
        project.path.toLowerCase().includes(normalized),
      )
      .slice(0, 8)
  }, [projectOptions, projectSearch])
  const filteredSessions = sessions
  const sessionProjectGroups = useMemo(() => {
    const groups = new Map<string, { path: string; name: string; sessions: Session[] }>()
    for (const session of filteredSessions) {
      const path = session.project_path || workspace.path || activeProjectPathForRequest || ''
      const key = sessionProjectKey(path, workspace.folder || '项目')
      const existing = groups.get(key)
      if (existing) {
        existing.sessions.push(session)
      } else {
        groups.set(key, {
          path,
          name: displayProjectName(path, projects, workspace),
          sessions: [session],
        })
      }
    }
    return Array.from(groups.values())
  }, [activeProjectPathForRequest, filteredSessions, projects, workspace])
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) {
      return {
        sessions: sessions.slice(0, 8),
      }
    }

    return {
      sessions: sessions
        .filter(session =>
          session.title.toLowerCase().includes(normalized) ||
          session.id.toLowerCase().includes(normalized),
        )
        .slice(0, 8),
    }
  }, [query, sessions])

  const activeChanges = useMemo(
    () => recentChanges.filter(change => change.status !== 'reverted'),
    [recentChanges],
  )
  const activeChangeCount = activeChanges.length
  const changeLineStats = activeChanges.reduce(
    (stats, change) => ({
      added: stats.added + (change.added_lines ?? 0),
      removed: stats.removed + (change.removed_lines ?? 0),
    }),
    { added: 0, removed: 0 },
  )
  const reviewTitle = activeChangeCount > 0 ? `${activeChangeCount} 项改动` : '代码改动'
  const reviewVisible = activeView === 'chat' && reviewOpen
  const selectedReviewChange = useMemo(
    () => recentChanges.find(change => change.id === selectedReviewChangeId) ?? activeChanges[0] ?? recentChanges[0] ?? null,
    [activeChanges, recentChanges, selectedReviewChangeId],
  )
  useEffect(() => {
    if (!reviewOpen) return
    const nextChange = selectedReviewChange ?? activeChanges[0] ?? recentChanges[0] ?? null
    if (!nextChange) {
      setReviewDiff(null)
      return
    }
    if (selectedReviewChangeId !== nextChange.id) {
      setSelectedReviewChangeId(nextChange.id)
    }
    if (reviewDiff?.changeId !== nextChange.id) {
      void loadReviewDiff(nextChange)
    }
  }, [activeChanges, recentChanges, reviewDiff?.changeId, reviewOpen, selectedReviewChange, selectedReviewChangeId])
  const slashCommandQuery = prompt.startsWith('/') && !prompt.includes('\n')
    ? prompt.slice(1).split(/\s+/)[0].toLowerCase()
    : null
  const filteredSlashCommands = useMemo(() => {
    if (slashCommandQuery === null) return []
    const normalized = slashCommandQuery.trim()
    const result = normalized
      ? slashCommands.filter(command =>
          command.name.includes(normalized) ||
          command.aliases.some(alias => alias.includes(normalized)) ||
          command.description.toLowerCase().includes(normalized),
        )
      : slashCommands
    return result.slice(0, 12)
  }, [slashCommandQuery, slashCommands])
  const slashCommandPanelOpen = activeView === 'chat' && slashCommandQuery !== null
  const activeFileMention = useMemo(
    () => findActiveFileMention(prompt, promptCursor),
    [prompt, promptCursor],
  )
  const fileMentionPanelOpen = activeView === 'chat' && Boolean(activeFileMention) && fileSuggestions.length > 0
  const fileMentionChips = useMemo(() => fileMentionRanges(prompt), [prompt])
  const isNewConversation =
    activeView === 'chat' && centerPanel === 'conversation' && visibleMessages.length === 0 && !isSending
  const workspaceFrameClass = [
    'workspace-frame',
    activeView === 'chat' && centerPanel === 'conversation' ? 'conversation-mode' : '',
    isNewConversation ? 'new-conversation-mode' : '',
    activeView !== 'chat' ? 'no-toolbar' : '',
  ].filter(Boolean).join(' ')

  useEffect(() => {
    if (!snapshotReady) return
    const timeout = window.setTimeout(() => {
      persistConversationState({
        activeSessionId,
        sessions,
        messages: messagesBySession,
      })
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [activeSessionId, messagesBySession, sessions, snapshotReady])

  useEffect(() => {
    persistArchivedSessions(archivedSessions)
  }, [archivedSessions])

  useEffect(() => {
    document.documentElement.dataset.sparkDensity = uiDensity
    try {
      window.localStorage.setItem(UI_DENSITY_STORAGE_KEY, uiDensity)
    } catch {
      // Best-effort UI preference persistence.
    }
  }, [uiDensity])

  useEffect(() => {
    if (sessions.some(session => session.id === activeSessionId)) return
    setActiveSessionId(sessions[0]?.id ?? fallbackSnapshot.sessions[0].id)
  }, [activeSessionId, sessions])

  useEffect(() => {
    setActiveSlashCommandIndex(0)
  }, [slashCommandQuery])

  useEffect(() => {
    setActiveFileSuggestionIndex(0)
    if (!activeFileMention) {
      setFileSuggestions([])
      return
    }
    let cancelled = false
    safeInvoke<ProjectFileEntry[]>('list_project_files', {
      projectPath: activeProjectPathForRequest,
      query: activeFileMention.query,
    })
      .then(files => {
        if (!cancelled) setFileSuggestions(files.slice(0, 10))
      })
      .catch(() => {
        if (!cancelled) setFileSuggestions([])
      })
    return () => {
      cancelled = true
    }
  }, [activeFileMention?.query, activeFileMention?.start, activeProjectPathForRequest])

  useEffect(() => {
    let cancelled = false
    const projectPath = activeProjectPathForRequest.trim()
    if (!projectPath) return

    safeInvoke<ProjectEntry>('get_project_metadata', { projectPath })
      .then(project => {
        if (!cancelled) syncProjectMetadata(project, project.path === activeProjectPathForRequest)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [activeProjectPathForRequest])

  useEffect(() => {
    setDirectoryPath('')
    setDirectoryEntries([])
    setActiveFileDocument(null)
    setFileDraft('')
  }, [activeProjectPathForRequest])

  useEffect(() => {
    if (centerPanel !== 'editing') return
    let cancelled = false
    setIsLoadingDirectory(true)
    safeInvoke<ProjectDirectoryEntry[]>('list_project_directory', {
      projectPath: activeProjectPathForRequest,
      directoryPath,
    })
      .then(entries => {
        if (!cancelled) setDirectoryEntries(entries)
      })
      .catch(error => {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : String(error))
          setDirectoryEntries([])
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingDirectory(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectPathForRequest, centerPanel, directoryPath])

  function openChat() {
    setActiveView('chat')
    setCenterPanel('conversation')
    setSettingsMenuOpen(false)
  }

  function openSession(session: Session) {
    setActiveSessionId(session.id)
    if (session.project_path) {
      setActiveProjectPath(session.project_path)
      persistActiveProjectPath(session.project_path)
      void syncActiveProjectToBackend(session.project_path)
    }
    openChat()
    window.setTimeout(() => scrollConversationToBottom('auto'), 0)
    window.setTimeout(() => scrollConversationToBottom('auto'), 180)
  }

  async function handleStartLogin() {
    setIsStartingLogin(true)
    setNotice(null)
    try {
      await safeInvoke<string>('start_spark_login')
      await refreshSnapshot()
      setNotice(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsStartingLogin(false)
    }
  }

  async function handleSparkLogout() {
    setIsLoggingOut(true)
    setNotice(null)
    try {
      const user = await safeInvoke<SparkUserProfile>('logout_spark')
      setSnapshot(current => ({
        ...current,
        spark_user: user,
        remote_device: {
          ...current.remote_device,
          bound: false,
          status: current.remote_device.configured ? '待输入绑定码' : '未绑定',
        },
      }))
      await refreshSnapshot()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoggingOut(false)
    }
  }

  async function handleModelChange(model: string) {
    const selected = model.trim()
    if (!selected || selected === snapshot.model.selected) {
      setModelMenuOpen(false)
      return
    }
    setIsSavingModel(true)
    setNotice(null)
    setModelSyncError(null)
    setModelMenuOpen(false)
    try {
      const next = await safeInvoke<ModelConfig>('save_model_config', { model: selected })
      setSnapshot(current => ({ ...current, model: next }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingModel(false)
    }
  }

  async function handlePreferenceChange(next: AppPreferences) {
    const previous = snapshot.preferences
    setIsSavingPreferences(true)
    setNotice(null)
    setSnapshot(current => ({ ...current, preferences: next }))
    try {
      const saved = await safeInvoke<AppPreferences>('save_preferences', { preferences: next })
      setSnapshot(current => ({ ...current, preferences: saved }))
      if (previous.permission_mode !== saved.permission_mode) {
        await refreshToolCatalog(saved.permission_mode)
      }
    } catch (error) {
      setSnapshot(current => ({ ...current, preferences: previous }))
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingPreferences(false)
    }
  }

  function updatePreference<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
    void handlePreferenceChange({
      ...preferences,
      [key]: value,
    })
  }

  async function refreshMemoryDocument() {
    setIsLoadingMemory(true)
    try {
      const document = await safeInvoke<MemoryDocument>('read_memory_file')
      setMemoryDocument(document)
      setMemoryDraft(document.content)
      setMemoryEntries(parseMemoryEntries(document.content))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingMemory(false)
    }
  }

  async function handleSaveMemory() {
    setIsSavingMemory(true)
    setNotice(null)
    try {
      const document = await safeInvoke<MemoryDocument>('save_memory_file', { content: memoryDraft })
      setMemoryDocument(document)
      setMemoryDraft(document.content)
      setMemoryEntries(parseMemoryEntries(document.content))
      setNotice('记忆已保存')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingMemory(false)
    }
  }

  async function handleDeleteMemory() {
    if (!window.confirm('删除当前记忆内容？')) return
    setIsSavingMemory(true)
    setNotice(null)
    try {
      const document = await safeInvoke<MemoryDocument>('delete_memory_file')
      setMemoryDocument(document)
      setMemoryDraft('')
      setMemoryEntries([])
      setNotice('记忆已删除')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingMemory(false)
    }
  }

  function updateMemoryEntry(id: string, text: string) {
    setMemoryEntries(current => current.map(entry => entry.id === id ? { ...entry, text } : entry))
  }

  function deleteMemoryEntry(id: string) {
    setMemoryEntries(current => current.filter(entry => entry.id !== id))
  }

  function addMemoryEntry() {
    setMemoryEntries(current => [
      ...current,
      { id: `memory-new-${Date.now()}`, text: '' },
    ])
  }

  async function handleSaveMemoryEntries() {
    const content = serializeMemoryEntries(memoryEntries)
    setMemoryDraft(content)
    setIsSavingMemory(true)
    setNotice(null)
    try {
      const document = await safeInvoke<MemoryDocument>('save_memory_file', { content })
      setMemoryDocument(document)
      setMemoryDraft(document.content)
      setMemoryEntries(parseMemoryEntries(document.content))
      setNotice('记忆已保存')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingMemory(false)
    }
  }

  function setComposerMode(mode: ComposerMode) {
    setPlanModeEnabled(mode === 'plan')
    setGoalModeEnabled(mode === 'goal')
    setModeMenuOpen(false)
  }

  async function handleBindRemoteDevice() {
    const bindingCode = remoteBindCode.trim()
    if (!bindingCode) {
      setNotice('请输入 Remote 绑定码')
      return
    }

    setIsBindingRemoteDevice(true)
    setNotice(null)
    try {
      const device = await safeInvoke<RemoteDeviceBinding>('bind_remote_device', { bindingCode })
      setSnapshot(current => ({ ...current, remote_device: device }))
      setRemoteBindCode('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBindingRemoteDevice(false)
    }
  }

  async function handleUnbindRemoteDevice() {
    setIsBindingRemoteDevice(true)
    setNotice(null)
    try {
      const device = await safeInvoke<RemoteDeviceBinding>('unbind_remote_device')
      setSnapshot(current => ({ ...current, remote_device: device }))
      setRemoteBindCode('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsBindingRemoteDevice(false)
    }
  }

  async function handleRevertChange(changeId: string) {
    setRevertingChangeId(changeId)
    setChangeNotice(null)
    try {
      const recentChanges = await safeInvoke<RecentChange[]>('revert_change', { changeId })
      setSnapshot(current => ({ ...current, recent_changes: recentChanges }))
      setReviewDiff(null)
    } catch (error) {
      setChangeNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setRevertingChangeId(null)
    }
  }

  async function loadReviewDiff(change: RecentChange | null) {
    if (!change) {
      setReviewDiff(null)
      return
    }

    setSelectedReviewChangeId(change.id)
    setIsLoadingReviewDiff(true)
    setReviewDiff({ changeId: change.id, rows: [], error: null })
    try {
      let afterContent = ''
      try {
        const document = await safeInvoke<ProjectFileDocument>('read_project_file', {
          projectPath: activeProjectPathForRequest,
          filePath: change.path,
        })
        afterContent = document.content
      } catch {
        afterContent = ''
      }
      const beforeContent = change.before_content ?? ''
      setReviewDiff({
        changeId: change.id,
        rows: buildReviewDiff(beforeContent, afterContent),
        error: null,
      })
    } catch (error) {
      setReviewDiff({
        changeId: change.id,
        rows: [],
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setIsLoadingReviewDiff(false)
    }
  }

  async function handleRevertActiveChanges() {
    const revertibleChanges = activeChanges.filter(change => change.can_revert)
    if (revertibleChanges.length === 0) {
      setChangeNotice('当前没有可撤销的改动')
      return
    }

    setRevertingChangeId('__all__')
    setChangeNotice(null)
    try {
      let nextChanges = recentChanges
      for (const change of revertibleChanges) {
        nextChanges = await safeInvoke<RecentChange[]>('revert_change', { changeId: change.id })
      }
      setSnapshot(current => ({ ...current, recent_changes: nextChanges }))
    } catch (error) {
      setChangeNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setRevertingChangeId(null)
    }
  }

  async function handleReviewActiveChanges() {
    setReviewOpen(true)
    if (activeChanges.length === 0) {
      addLocalResultMessage('当前没有可审查的近期更改')
      return
    }
    await loadReviewDiff(activeChanges[0])
  }

  async function refreshProjectDirectory(nextDirectoryPath = directoryPath) {
    setIsLoadingDirectory(true)
    setNotice(null)
    try {
      const entries = await safeInvoke<ProjectDirectoryEntry[]>('list_project_directory', {
        projectPath: activeProjectPathForRequest,
        directoryPath: nextDirectoryPath,
      })
      setDirectoryPath(nextDirectoryPath)
      setDirectoryEntries(entries)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      setDirectoryEntries([])
    } finally {
      setIsLoadingDirectory(false)
    }
  }

  async function openProjectFile(filePath: string) {
    setIsLoadingFileDocument(true)
    setNotice(null)
    try {
      const document = await safeInvoke<ProjectFileDocument>('read_project_file', {
        projectPath: activeProjectPathForRequest,
        filePath,
      })
      setActiveFileDocument(document)
      setFileDraft(document.content)
      setCenterPanel('editing')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingFileDocument(false)
    }
  }

  function createProjectFileDraft() {
    const filePath = window.prompt('输入项目内文件路径', directoryPath ? `${directoryPath}/` : '')
    const normalized = filePath?.trim().replace(/^\.\/+/, '').replace(/\\/g, '/')
    if (!normalized) return
    if (!isSafeProjectRelativePath(normalized)) {
      setNotice('文件路径必须是当前项目内的相对路径，不能包含 ..')
      return
    }
    setActiveFileDocument({
      path: normalized,
      name: normalized.split('/').pop() || normalized,
      content: '',
      exists: false,
      size: 0,
      modified_at: null,
      recent_changes: [],
    })
    setFileDraft('')
    setCenterPanel('editing')
  }

  async function createProjectDirectory() {
    const directory = window.prompt('输入项目内文件夹路径', directoryPath ? `${directoryPath}/` : '')
    const normalized = directory?.trim().replace(/^\.\/+/, '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalized) return
    if (!isSafeProjectRelativePath(normalized)) {
      setNotice('文件夹路径必须是当前项目内的相对路径，不能包含 ..')
      return
    }
    setIsLoadingDirectory(true)
    setNotice(null)
    try {
      const entries = await safeInvoke<ProjectDirectoryEntry[]>('create_project_directory', {
        projectPath: activeProjectPathForRequest,
        directoryPath: normalized,
      })
      setDirectoryPath(parentDirectory(normalized))
      setDirectoryEntries(entries)
      setNotice(`已创建文件夹 ${normalized}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingDirectory(false)
    }
  }

  async function renameProjectEntry(entry: ProjectDirectoryEntry | ProjectFileDocument) {
    const currentPath = entry.path
    const nextPath = window.prompt('输入新的项目内路径', currentPath)
    const normalized = nextPath?.trim().replace(/^\.\/+/, '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalized || normalized === currentPath) return
    if (!isSafeProjectRelativePath(normalized)) {
      setNotice('新路径必须是当前项目内的相对路径，不能包含 ..')
      return
    }
    setIsLoadingDirectory(true)
    setNotice(null)
    try {
      const entries = await safeInvoke<ProjectDirectoryEntry[]>('rename_project_entry', {
        projectPath: activeProjectPathForRequest,
        fromPath: currentPath,
        toPath: normalized,
      })
      const nextParent = parentDirectory(normalized)
      setDirectoryPath(nextParent)
      setDirectoryEntries(entries)
      if (activeFileDocument?.path === currentPath) {
        await openProjectFile(normalized)
      }
      setNotice(`已重命名为 ${normalized}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingDirectory(false)
    }
  }

  async function deleteProjectDirectory(entry: ProjectDirectoryEntry) {
    if (!entry.is_dir) return
    if (!window.confirm(`删除空文件夹 ${entry.path}？`)) return
    setIsLoadingDirectory(true)
    setNotice(null)
    try {
      const entries = await safeInvoke<ProjectDirectoryEntry[]>('delete_project_directory', {
        projectPath: activeProjectPathForRequest,
        directoryPath: entry.path,
      })
      setDirectoryPath(parentDirectory(entry.path))
      setDirectoryEntries(entries)
      setNotice(`已删除文件夹 ${entry.path}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingDirectory(false)
    }
  }

  async function saveActiveProjectFile() {
    if (!activeFileDocument) return
    setIsSavingFileDocument(true)
    setNotice(null)
    try {
      const document = await safeInvoke<ProjectFileDocument>('save_project_file', {
        projectPath: activeProjectPathForRequest,
        filePath: activeFileDocument.path,
        content: fileDraft,
      })
      setActiveFileDocument(document)
      setFileDraft(document.content)
      setSnapshot(current => ({ ...current, recent_changes: document.recent_changes }))
      await refreshProjectDirectory(parentDirectory(document.path))
      setNotice(`已保存 ${document.path}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingFileDocument(false)
    }
  }

  async function deleteActiveProjectFile() {
    if (!activeFileDocument?.exists) return
    if (!window.confirm(`删除 ${activeFileDocument.path}？`)) return
    setIsSavingFileDocument(true)
    setNotice(null)
    try {
      const recentChanges = await safeInvoke<RecentChange[]>('delete_project_file', {
        projectPath: activeProjectPathForRequest,
        filePath: activeFileDocument.path,
      })
      setSnapshot(current => ({ ...current, recent_changes: recentChanges }))
      const parent = parentDirectory(activeFileDocument.path)
      setActiveFileDocument(null)
      setFileDraft('')
      await refreshProjectDirectory(parent)
      setNotice(`已删除 ${activeFileDocument.path}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingFileDocument(false)
    }
  }

  function openSessionContextMenu(event: MouseEvent, session: Session) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      type: 'session',
      x: event.clientX,
      y: event.clientY,
      sessionId: session.id,
    })
  }

  async function handleRenameSession(session: Session) {
    const nextTitle = window.prompt('重命名会话', session.title)?.trim()
    if (!nextTitle || nextTitle === session.title) return

    setSnapshot(current => ({
      ...current,
      sessions: current.sessions.map(item =>
        item.id === session.id ? { ...item, title: nextTitle } : item,
      ),
    }))
    try {
      const sessions = await safeInvoke<Session[]>('rename_session', {
        sessionId: session.id,
        title: nextTitle,
      })
      setSnapshot(current => ({ ...current, sessions }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      await refreshSnapshot().catch(() => {})
    }
  }

  function updateSessionTitle(session: Session, title: string) {
    const nextTitle = title.trim()
    if (!nextTitle || !isUntitledSession(session)) return

    setSnapshot(current => ({
      ...current,
      sessions: current.sessions.map(item =>
        item.id === session.id ? { ...item, title: nextTitle } : item,
      ),
    }))

    safeInvoke<Session[]>('rename_session', {
      sessionId: session.id,
      title: nextTitle,
    })
      .then(sessions => {
        setSnapshot(current => ({ ...current, sessions }))
      })
      .catch(() => {})
  }

  async function handleArchiveSession(session: Session) {
    const archivedMessages = messagesBySession[session.id] ?? []
    setArchivedSessions(current => [
      {
        session,
        messages: archivedMessages,
        archivedAt: Date.now(),
      },
      ...current.filter(item => item.session.id !== session.id),
    ])
    const remaining = sessions.filter(item => item.id !== session.id)
    setSnapshot(current => ({ ...current, sessions: remaining }))
    setMessagesBySession(current => {
      const next = { ...current }
      delete next[session.id]
      return next
    })
    setQueuedPrompts(current => current.filter(item => item.sessionId !== session.id))
    if (activeSession.id === session.id) {
      setActiveSessionId(remaining[0]?.id ?? fallbackSnapshot.sessions[0].id)
    }

    try {
      const saved = await safeInvoke<Session[]>('archive_session', {
        sessionId: session.id,
      })
      setSnapshot(current => ({ ...current, sessions: saved }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      await refreshSnapshot().catch(() => {})
    }
  }

  function handleRestoreArchivedSession(entry: ArchivedSessionEntry) {
    setArchivedSessions(current => current.filter(item => item.session.id !== entry.session.id))
    setSnapshot(current => ({
      ...current,
      sessions: [entry.session, ...current.sessions.filter(session => session.id !== entry.session.id)],
    }))
    setMessagesBySession(current => ({
      ...current,
      [entry.session.id]: entry.messages,
    }))
    setActiveSessionId(entry.session.id)
    openChat()
  }

  function handleDeleteArchivedSession(entry: ArchivedSessionEntry) {
    if (!window.confirm(`删除归档对话：${entry.session.title}`)) return
    setArchivedSessions(current => current.filter(item => item.session.id !== entry.session.id))
  }

  async function handleRemoveProject(project: ProjectEntry) {
    if (!window.confirm(`移除项目：${project.name}`)) return

    setNotice(null)
    try {
      const saved = await safeInvoke<ProjectEntry[]>('remove_project_path', {
        projectPath: project.path,
      })
      setSnapshot(current => {
        const nextSessions = current.sessions.filter(session => session.project_path !== project.path)
        return {
          ...current,
          projects: saved,
          sessions: nextSessions.length > 0 ? nextSessions : current.sessions,
        }
      })
      setMessagesBySession(current => {
        const next = { ...current }
        for (const session of sessions) {
          if (session.project_path === project.path) {
            delete next[session.id]
          }
        }
        return next
      })
      setQueuedPrompts(current => current.filter(item => {
        const session = sessions.find(candidate => candidate.id === item.sessionId)
        return session?.project_path !== project.path
      }))
      if (activeSession.project_path === project.path) {
        const nextSession = sessions.find(session => session.project_path !== project.path)
        setActiveSessionId(nextSession?.id ?? fallbackSnapshot.sessions[0].id)
        const nextProjectPath = nextSession?.project_path || workspace.path || ''
        setActiveProjectPath(nextProjectPath)
        persistActiveProjectPath(nextProjectPath)
        void syncActiveProjectToBackend(nextProjectPath)
      }
      await refreshSnapshot().catch(() => {})
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  function syncProjectMetadata(project: ProjectEntry, updateWorkspace = project.path === activeProjectPathForRequest) {
    const path = project.path.trim()
    if (!path) return
    const name = project.name || displayProjectName(path, projects, workspace)
    const normalizedProject: ProjectEntry = {
      ...project,
      id: project.id || path,
      name,
      path,
    }

    setSnapshot(current => {
      const savedProjects = current.projects.some(item => item.path === path)
        ? current.projects.map(item => (item.path === path ? { ...item, ...normalizedProject } : item))
        : [normalizedProject, ...current.projects]

      return {
        ...current,
        projects: savedProjects,
        workspace: updateWorkspace
          ? {
              ...current.workspace,
              folder: name,
              path,
              git_branch: normalizedProject.git_branch,
            }
          : current.workspace,
      }
    })
  }

  async function refreshProjectMetadata(projectPath = activeProjectPathForRequest) {
    const path = projectPath.trim()
    if (!path) return null
    const project = await safeInvoke<ProjectEntry>('get_project_metadata', { projectPath: path })
    syncProjectMetadata(project, path === activeProjectPathForRequest)
    return project
  }

  async function activateProject(project: ProjectEntry) {
    const path = project.path.trim()
    if (!path) return
    syncProjectMetadata(project, true)
    setActiveProjectPath(path)
    persistActiveProjectPath(path)
    await syncActiveProjectToBackend(path)

    const existingSession = sessions.find(session => session.project_path === path)
    if (existingSession) {
      openSession(existingSession)
      return
    }

    const session = await safeInvoke<Session>('start_session', {
      title: '当前会话',
      projectPath: path,
    })
    setSnapshot(current => ({ ...current, sessions: [session, ...current.sessions] }))
    openSession(session)
    setMessagesBySession(current => ({
      ...current,
      [session.id]: [],
    }))
  }

  async function handleSelectProject(project: ProjectEntry) {
    setProjectMenuOpen(false)
    setNotice(null)
    try {
      const freshProject = await refreshProjectMetadata(project.path).catch(() => project)
      await activateProject(freshProject || project)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleAddProjectPath() {
    let path: string | null = null
    try {
      path = await safeInvoke<string | null>('pick_project_folder', {
        basePath: activeProjectPathForRequest,
      })
    } catch {
      path = window.prompt('输入项目文件夹路径', activeProjectPathForRequest)
    }
    if (!path?.trim()) return

    setProjectMenuOpen(false)
    setNotice(null)
    try {
      const project = await safeInvoke<ProjectEntry>('add_project_path', {
        path: path.trim(),
        basePath: activeProjectPathForRequest,
      })
      await activateProject(project)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  function projectEntryForPath(projectPath: string): ProjectEntry | null {
    const normalized = projectPath.trim()
    if (!normalized) return null
    return projects.find(project => project.path === normalized) ?? {
      id: normalized,
      name: displayProjectName(normalized, projects, workspace),
      path: normalized,
      git_branch: null,
      trust_level: null,
    }
  }

  function toggleProjectCollapsed(projectPath: string, fallback: string) {
    const key = sessionProjectKey(projectPath, fallback)
    setCollapsedProjectPaths(current => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  async function copyText(value: string, label: string) {
    await navigator.clipboard?.writeText(value)
    void label
  }

  async function handleNewSession() {
    if (creatingSessionRef.current) return

    if (visibleMessages.length === 0 && !prompt.trim() && !isSending) {
      openChat()
      return
    }

    const title = `会话 ${sessions.length + 1}`
    const projectPath = activeProjectPathForRequest
    creatingSessionRef.current = true
    setIsCreatingSession(true)
    try {
      const session = await safeInvoke<Session>('start_session', { title, projectPath })
      setSnapshot(current => ({ ...current, sessions: [session, ...current.sessions] }))
      openSession(session)
      setMessagesBySession(current => ({
        ...current,
        [session.id]: [],
      }))
    } catch {
      const session: Session = {
        id: `local-${Date.now()}`,
        title,
        tokens: 0,
        context_used: 0,
        context_limit: 1_000_000,
        project_path: projectPath,
        remote: snapshot.remote.configured,
      }
      setSnapshot(current => ({ ...current, sessions: [session, ...current.sessions] }))
      openSession(session)
      setMessagesBySession(current => ({
        ...current,
        [session.id]: [],
      }))
    } finally {
      creatingSessionRef.current = false
      setIsCreatingSession(false)
      openChat()
    }
  }

  function insertSlashCommand(command: SlashCommandEntry) {
    setPrompt(`/${command.name}${command.accepts_args ? ' ' : ''}`)
    setTimeout(() => promptRef.current?.focus(), 0)
  }

  function updatePromptCursor() {
    const cursor = promptRef.current?.selectionStart ?? prompt.length
    setPromptCursor(cursor)
  }

  function insertFileMention(file: ProjectFileEntry) {
    if (!activeFileMention) return
    const next = `${prompt.slice(0, activeFileMention.start)}@${file.path} ${prompt.slice(activeFileMention.end)}`
    const cursor = activeFileMention.start + file.path.length + 2
    setPrompt(next)
    setFileSuggestions([])
    setPromptCursor(cursor)
    setTimeout(() => {
      promptRef.current?.focus()
      promptRef.current?.setSelectionRange(cursor, cursor)
    }, 0)
  }

  function removeFileMention(start: number, end: number) {
    const next = `${prompt.slice(0, start)}${prompt.slice(end)}`.replace(/\s{2,}/g, ' ')
    setPrompt(next)
    setTimeout(() => promptRef.current?.focus(), 0)
  }

  async function readNativeClipboardFilePaths(): Promise<string[]> {
    try {
      return await safeInvoke<string[]>('read_clipboard_file_paths')
    } catch {
      return []
    }
  }

  async function handleImageFiles(files: FileList | File[] | null, options: { silent?: boolean } = {}) {
    if (!files || files.length === 0) return 0
    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'))
    if (imageFiles.length === 0) {
      if (!options.silent) setNotice('请选择图片文件')
      return 0
    }
    const images = await Promise.all(
      imageFiles.map((file, index) => new Promise<ImageAttachment>((resolve, reject) => {
        const name = imageAttachmentName(file, index)
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result ?? '')
          resolve({
            id: `img-${Date.now()}-${name}-${Math.random().toString(16).slice(2)}`,
            name,
            media_type: file.type || 'image/png',
            data: dataUrl.includes(',') ? dataUrl.split(',').pop() ?? '' : dataUrl,
          })
        }
        reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
        reader.readAsDataURL(file)
      })),
    )
    setImageAttachments(current => [...current, ...images])
    return images.length
  }

  function insertFileMentionTexts(paths: string[]) {
    if (paths.length === 0) return 0

    const mentions = paths.map(path => `@${path}`).join(' ')
    const cursor = promptRef.current?.selectionStart ?? promptCursor ?? prompt.length
    const before = prompt.slice(0, cursor)
    const after = prompt.slice(cursor)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    const insertion = `${prefix}${mentions}${suffix}`
    const next = `${before}${insertion}${after}`
    const nextCursor = before.length + insertion.length

    setPrompt(next)
    setPromptCursor(nextCursor)
    setTimeout(() => {
      promptRef.current?.focus()
      promptRef.current?.setSelectionRange(nextCursor, nextCursor)
    }, 0)
    return paths.length
  }

  function insertDroppedPathMentions(paths: string[]) {
    return insertFileMentionTexts(
      paths.map(path => projectRelativeMentionPath(
        path,
        activeProjectPathForRequest,
        path.split(/[\\/]/).pop() || path,
      )),
    )
  }

  async function handleDroppedFiles(
    files: FileList | File[] | null,
    options: { nativePaths?: string[]; source?: 'drop' | 'paste' | 'picker' } = {},
  ) {
    const dropped = Array.from(files ?? [])
    if (dropped.length === 0) return

    const imageFiles = dropped.filter(file => file.type.startsWith('image/'))
    const regularFiles = dropped.filter(file => !file.type.startsWith('image/'))
    const regularResult = fileMentionPathsForFiles(
      regularFiles,
      activeProjectPathForRequest,
      options.nativePaths ?? [],
    )
    insertFileMentionTexts(regularResult.paths)
    const imageCount = await handleImageFiles(imageFiles, { silent: true })
    if (regularFiles.length === 0 && imageCount === 0) {
      setNotice('没有可加入的文件')
    } else if (options.source === 'paste' && regularResult.unresolved > 0) {
      setNotice('已插入文件名引用；如果后端读不到，请用 + 添加文件或直接拖入文件')
    }
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboard = event.clipboardData
    const files = clipboardFiles(clipboard)
    const looksLikeFilePaste = clipboardLooksLikeFilePaste(clipboard)
    const textPaths = looksLikeFilePaste ? clipboardTextFilePaths(clipboard) : []

    if (files.length === 0 && textPaths.length === 0 && !looksLikeFilePaste) {
      return
    }

    event.preventDefault()
    const nativePaths = await readNativeClipboardFilePaths()
    const resolvedPaths = nativePaths.length > 0 ? nativePaths : textPaths

    if (files.length > 0) {
      await handleDroppedFiles(files, { nativePaths: resolvedPaths, source: 'paste' })
      return
    }

    const inserted = insertDroppedPathMentions(resolvedPaths)
    if (inserted === 0) {
      setNotice('剪贴板里没有可加入的图片或文件')
    }
  }

  function handleComposerDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    setIsComposerDragging(true)
  }

  function handleComposerDragOver(event: DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setIsComposerDragging(true)
  }

  function handleComposerDragLeave(event: DragEvent<HTMLDivElement>) {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return
    setIsComposerDragging(false)
  }

  function handleComposerDrop(event: DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    setIsComposerDragging(false)
    void handleDroppedFiles(event.dataTransfer.files)
  }

  function addSystemMessage(content: string, sessionId = activeSession.id) {
    setSessionMessages(sessionId, current => [
      ...current,
      {
        id: `system-${Date.now()}-${current.length}`,
        role: 'assistant',
        content,
        created_at: Date.now(),
      },
    ])
  }

  function addLocalResultMessage(content: string, sessionId = activeSession.id) {
    setSessionMessages(sessionId, current => [
      ...current,
      {
        id: `local-${Date.now()}-${current.length}`,
        role: 'assistant',
        content,
        created_at: Date.now(),
      },
    ])
  }

  function appendRuntimeEvent(event: RuntimeEvent | null) {
    if (!event) return
    setRuntimeEvents(current => [...current, { ...event, created_at: event.created_at ?? Date.now() }].slice(-48))
  }

  function upsertPendingPermission(request: GuiPermissionRequest) {
    setPendingPermissions(current => {
      const next = current.filter(item => item.id !== request.id)
      return [...next, request].slice(-6)
    })
  }

  async function respondToPermissionRequest(
    request: GuiPermissionRequest,
    decision: GuiPermissionDecision,
  ) {
    const baseUrl = snapshot.backend_runtime.local_url?.trim().replace(/\/+$/, '')
    if (!baseUrl) {
      setNotice('本地后端尚未就绪，无法响应权限请求')
      return
    }

    setRespondingPermissionIds(current => new Set(current).add(request.id))
    try {
      const response = await fetch(`${baseUrl}/permissions/${encodeURIComponent(request.id)}/respond`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${snapshot.backend_runtime.auth_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(payload?.error || `权限响应失败：${response.status}`)
      }
      setPendingPermissions(current => current.filter(item => item.id !== request.id))
      appendRuntimeEvent({
        id: runtimeEventId('permission-response'),
        label: decision === 'deny' ? '权限已拒绝' : '权限已允许',
        value: request.tool_name,
        tone: decision === 'deny' ? 'warning' : 'success',
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setRespondingPermissionIds(current => {
        const next = new Set(current)
        next.delete(request.id)
        return next
      })
    }
  }

  function bumpSessionUsage(sessionId: string, effectivePrompt: string, images: ImageAttachment[]) {
    const used = Math.ceil(effectivePrompt.length / 2) + (images.length * 120) + 480
    setSnapshot(current => ({
      ...current,
      sessions: current.sessions.map(session =>
        session.id === sessionId
          ? {
              ...session,
              tokens: session.tokens + used,
              context_used: Math.min(session.context_limit, session.context_used + used),
            }
          : session,
      ),
    }))
  }

  async function streamPromptContent(input: {
    effectivePrompt: string
    targetSession: Session
    shouldResumeBackendSession: boolean
    images: ImageAttachment[]
  }): Promise<boolean> {
    const runtime = snapshot.backend_runtime
    const baseUrl = runtime.local_url?.trim().replace(/\/+$/, '')
    if (!runtime.streaming_enabled || !baseUrl) return false

	    const assistantId = `a-stream-${Date.now()}`
	    const thinkingChainId = thinkingChainMessageId(assistantId)
	    const startedAt = Date.now()
	    let assistantContent = ''
	    let completed = false
	    let hasToolOutput = false
	    let pendingAssistantContent: string | null = null
	    let assistantFlushTimer = 0

	    const keepAssistantAtEnd = (messages: ChatMessage[]) => {
	      const assistant = messages.find(message => message.id === assistantId)
	      if (!assistant) return messages
	      return [
	        ...messages.filter(message => message.id !== assistantId),
	        assistant,
	      ]
	    }
	
	    const updateThinkingChain = (updater: (payload: ThinkingChainPayload) => ThinkingChainPayload) => {
	      setSessionMessages(input.targetSession.id, current => keepAssistantAtEnd(current.map(message => {
	        if (message.id !== thinkingChainId) return message
	        const payload = parseThinkingChain(message.content) ?? {
	          started_at: startedAt,
	          ended_at: null,
	          events: [],
	        }
	        return {
	          ...message,
	          content: serializeThinkingChain(updater(payload)),
	        }
	      })))
	    }

	    const appendThinkingEvent = (event: Omit<RuntimeEvent, 'created_at'>) => {
	      const nextEvent: ThinkingChainEvent = {
	        ...event,
	        created_at: Date.now(),
	      }
	      appendRuntimeEvent(nextEvent)
	      updateThinkingChain(payload => ({
	        ...payload,
	        events: [...payload.events, nextEvent].slice(-80),
	      }))
	    }

	    const finishThinkingChain = () => {
	      updateThinkingChain(payload => ({
	        ...payload,
	        ended_at: payload.ended_at ?? Date.now(),
	      }))
	    }

	    const upsertToolOutput = (toolUseId: string, content: string) => {
	      const id = `terminal-output-${toolUseId || runtimeEventId('tool-result')}`
	      setSessionMessages(input.targetSession.id, current => {
	        if (current.some(message => message.id === id)) {
	          return keepAssistantAtEnd(current.map(message =>
	            message.id === id ? { ...message, content } : message,
	          ))
	        }
	        return keepAssistantAtEnd([
	          ...current,
	          {
	            id,
	            role: 'assistant',
	            content,
	            created_at: Date.now(),
	          },
	        ])
	      })
	    }

    const flushAssistant = () => {
      if (assistantFlushTimer) {
        window.clearTimeout(assistantFlushTimer)
        assistantFlushTimer = 0
      }
      if (pendingAssistantContent === null) return
      const content = pendingAssistantContent
      pendingAssistantContent = null
      setSessionMessages(input.targetSession.id, current =>
        keepAssistantAtEnd(current.map(message =>
          message.id === assistantId ? { ...message, content } : message,
        )),
      )
    }
    const writeAssistant = (content: string, immediate = false) => {
      pendingAssistantContent = content
      if (immediate) {
        flushAssistant()
        return
      }
      if (!assistantFlushTimer) {
        assistantFlushTimer = window.setTimeout(flushAssistant, 45)
      }
    }
    const removeAssistant = () => {
      if (assistantFlushTimer) {
        window.clearTimeout(assistantFlushTimer)
        assistantFlushTimer = 0
      }
      pendingAssistantContent = null
	      setSessionMessages(input.targetSession.id, current =>
	        current.filter(message => message.id !== assistantId && message.id !== thinkingChainId),
	      )
	    }
    const setAssistantStatus = (status: string | null, immediate = false) => {
      writeAssistant(status ? `正在思考\n${status}` : '正在思考\n', immediate)
    }
    const applyStreamPayload = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const record = payload as Record<string, unknown>
      const backendMessage = record.type === 'event' ? record.event : record
	      const permissionRequest = permissionRequestFromBackendMessage(backendMessage)
	      if (permissionRequest) {
	        upsertPendingPermission(permissionRequest)
	        appendThinkingEvent({
	          id: runtimeEventId('permission-request'),
	          label: '等待权限',
	          value: `${permissionRequest.tool_name} 需要确认`,
          tone: 'warning',
        })
	        writeAssistant('等待权限确认', true)
	        return
	      }
	      const backendRuntimeEvent = runtimeEventFromBackendMessage(backendMessage)
	      if (backendRuntimeEvent) appendThinkingEvent(backendRuntimeEvent)
	      for (const block of toolUseBlocksFromBackendMessage(record)) {
	        hasToolOutput = true
	        const toolUseId = typeof block.id === 'string' ? block.id : runtimeEventId('tool-use')
	        const name = typeof block.name === 'string' ? block.name : '工具'
	        const title = toolInputTitle(name, block.input)
	        const body = toolInputBody(name, block.input)
	        appendThinkingEvent({
	          id: `thinking-tool-${toolUseId}`,
	          label: title,
	          value: body || title,
	          tone: 'info',
	        })
	      }
		      for (const block of toolResultBlocksFromBackendMessage(record)) {
		        hasToolOutput = true
		        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
		        const result = toolResultText(block.content || block.tool_use_result || block)
		        upsertToolOutput(toolUseId, result || '工具已完成')
		      }
      if (record.type === 'error') {
        throw new StreamPromptError(
          typeof record.error === 'string' ? record.error : '流式响应失败',
          true,
        )
      }
      if (record.type === 'status') {
        if (record.status === 'thinking' && !assistantContent) {
          setAssistantStatus(null)
        }
        if (record.status === 'thinking') {
          appendRuntimeEvent({
            id: runtimeEventId('thinking'),
            label: '正在思考',
            value: '等待模型和工具输出',
            tone: 'info',
          })
        }
        return
      }
      if (record.type === 'result') {
        const finalText =
          typeof record.content === 'string'
            ? record.content
            : textFromStreamContent(record.content)
	        if (!assistantContent.trim() && hasToolOutput && looksLikeToolOnlyOutput(finalText)) {
	          setSessionMessages(input.targetSession.id, current =>
	            current.filter(message => message.id !== assistantId),
	          )
	          completed = true
	          finishThinkingChain()
	          return
	        }
        assistantContent = finalText || assistantContent || '已完成'
        writeAssistant(assistantContent, true)
	        appendRuntimeEvent({
	          id: runtimeEventId('result'),
	          label: '完成',
	          value: '已收到最终响应',
	          tone: 'success',
	        })
	        completed = true
	        finishThinkingChain()
	        return
	      }

      const update = streamTextUpdate(record.type === 'event' ? record.event : record)
      if (!update?.text) return
      assistantContent = update.mode === 'append'
        ? `${assistantContent}${update.text}`
        : update.text
      writeAssistant(assistantContent)
    }

	    setSessionMessages(input.targetSession.id, current => [
	      ...current,
	      {
	        id: thinkingChainId,
	        role: 'system',
	        content: serializeThinkingChain({
	          started_at: startedAt,
	          ended_at: null,
	          events: [],
	        }),
	        created_at: startedAt,
	      },
	      {
	        id: assistantId,
	        role: 'assistant',
	        content: '正在思考\n',
	        created_at: startedAt,
	      },
	    ])
    setStreamingMessageId(assistantId)

    async function runAttempt(): Promise<void> {
      const abortController = new AbortController()
      const totalTimeout = window.setTimeout(() => abortController.abort(), 10 * 60 * 1000)
      let firstChunkTimeout = window.setTimeout(() => abortController.abort(), 12 * 1000)

      try {
        const response = await fetch(`${baseUrl}/prompt/stream`, {
          method: 'POST',
          signal: abortController.signal,
          headers: {
            authorization: `Bearer ${runtime.auth_token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            session_id: input.targetSession.id,
            session_key: `sparkcode-app:${input.targetSession.project_path || activeProjectPathForRequest}:${input.targetSession.id}`,
            prompt: input.effectivePrompt,
            cwd: input.targetSession.project_path || activeProjectPathForRequest,
            model: snapshot.model.selected,
            permission_mode: backendPermissionMode(preferences.permission_mode),
            resume: input.shouldResumeBackendSession,
            images: input.images,
          }),
        })

        if (!response.ok) {
          throw new StreamPromptError(`本地流式接口不可用：${response.status}`, false)
        }
        if (!response.body) {
          throw new StreamPromptError('本地流式接口没有返回数据流', false)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (firstChunkTimeout) {
            window.clearTimeout(firstChunkTimeout)
            firstChunkTimeout = 0
          }
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split(/\r?\n\r?\n/)
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const payload = parseSseDataFrame(frame)
            if (payload) applyStreamPayload(payload)
          }
        }
        buffer += decoder.decode()
        if (buffer.trim()) {
          const payload = parseSseDataFrame(buffer)
          if (payload) applyStreamPayload(payload)
        }

	        if (!completed) {
	          writeAssistant(assistantContent.trim() || '已完成', true)
	          finishThinkingChain()
	        }
      } finally {
        window.clearTimeout(totalTimeout)
        if (firstChunkTimeout) window.clearTimeout(firstChunkTimeout)
      }
    }

    try {
      const retryLimit = 5
      for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        try {
          assistantContent = ''
          completed = false
          hasToolOutput = false
          if (attempt === 0) setAssistantStatus(null, true)
          await runAttempt()
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isAuthExpiredMessage(message) || (error instanceof StreamPromptError && error.backendError)) {
            removeAssistant()
            throw error
	          }
	          if (attempt < retryLimit) {
	            appendThinkingEvent({
	              id: runtimeEventId('reconnect'),
	              label: 'Reconnecting',
	              value: `${attempt + 1}/${retryLimit}`,
	              tone: 'warning',
	            })
	            setAssistantStatus(null, true)
	            await new Promise(resolve => window.setTimeout(resolve, 700))
	            continue
	          }
          removeAssistant()
          throw new StreamPromptError(
            `流式传输失败，已重试 ${retryLimit} 次：${message}`,
            false,
            true,
          )
        }
      }
      return false
    } finally {
      flushAssistant()
      setStreamingMessageId(current => current === assistantId ? null : current)
    }
  }

  async function runBackendLocalCommand(name: string, args: string) {
    setPrompt('')
    setNotice(null)
    try {
      const content = await safeInvoke<string>('run_local_command', {
        name,
        args,
        projectPath: activeProjectPathForRequest || activeSession.project_path,
      })
      addLocalResultMessage(content)
    } catch (error) {
      addLocalResultMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function refreshBackendTasks() {
    setPrompt('')
    setNotice(null)
    const runtime = snapshot.backend_runtime
    const baseUrl = runtime.local_url?.trim().replace(/\/+$/, '')
    if (!baseUrl) {
      addLocalResultMessage('本地后端未启动，无法读取后台任务')
      return
    }
    try {
      const response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(activeSession.id)}/tasks`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.auth_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          cwd: activeSession.project_path || activeProjectPathForRequest,
          session_key: `sparkcode-app:${activeSession.project_path || activeProjectPathForRequest}:${activeSession.id}`,
          resume: true,
        }),
      })
      const payload = await response.json() as GuiTaskSummary[] | { error?: string }
      if (!response.ok) {
        throw new Error(!Array.isArray(payload) && payload.error ? payload.error : `读取后台任务失败：${response.status}`)
      }
      const tasks = Array.isArray(payload) ? payload : []
      if (tasks.length === 0) {
        addLocalResultMessage('后台任务\n当前没有正在运行或保留的后台任务')
        return
      }
      addLocalResultMessage([
        '后台任务',
        ...tasks.map(task => [
          `${task.status}  ${task.type}  ${task.id}`,
          task.command || task.description,
          `输出: ${task.output_file}`,
          task.output_tail ? `\n${task.output_tail}` : '',
        ].filter(Boolean).join('\n')),
      ].join('\n\n'))
    } catch (error) {
      addLocalResultMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function submitPromptContent(content: string, targetSession = activeSession, images: ImageAttachment[] = []) {
    const trimmed = content.trim()
    const effectivePrompt = trimmed || (images.length > 0 ? '请分析这些图片' : '')
    if (!effectivePrompt || isSending) return
    const requestProjectPath = targetSession.project_path || activeProjectPathForRequest
    const targetSessionForRequest = {
      ...targetSession,
      project_path: requestProjectPath,
    }
    const shouldResumeBackendSession = (messagesBySession[targetSession.id] ?? [])
      .some(message => message.role !== 'system')

    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: effectivePrompt,
      created_at: Date.now(),
      images,
    }
    setSessionMessages(targetSession.id, current => [...current, userMessage])
    if (!shouldResumeBackendSession) {
      updateSessionTitle(targetSession, sessionTitleFromPrompt(effectivePrompt, images.length))
    }
    setPrompt('')
    setImageAttachments([])
    setIsSending(true)
    setNotice(null)
    setRuntimeEvents([{
      id: runtimeEventId('request'),
      label: '发送请求',
      value: effectivePrompt.slice(0, 180),
      tone: 'info',
    }])

    try {
      let usedStream = false
      try {
        usedStream = await streamPromptContent({
          effectivePrompt,
          targetSession: targetSessionForRequest,
          shouldResumeBackendSession,
          images,
        })
      } catch (streamError) {
        const message = streamError instanceof Error ? streamError.message : String(streamError)
        if (
          streamError instanceof StreamPromptError &&
          (streamError.backendError || streamError.retryExhausted || isAuthExpiredMessage(message))
        ) {
          throw streamError
        }
      }

      if (!usedStream) {
        const response = await safeInvoke<ChatMessage>('send_prompt', {
          prompt: effectivePrompt,
          sessionId: targetSession.id,
          projectPath: requestProjectPath,
          model: snapshot.model.selected,
          permissionMode: preferences.permission_mode,
          resume: shouldResumeBackendSession,
          images,
        })
        setSessionMessages(targetSession.id, current => [...current, {
          ...response,
          created_at: response.created_at ?? Date.now(),
        }])
        appendRuntimeEvent({
          id: runtimeEventId('fallback-result'),
          label: '完成',
          value: '普通后端接口已返回响应',
          tone: 'success',
        })
      }
      bumpSessionUsage(targetSession.id, effectivePrompt, images)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      addSystemMessage(message, targetSession.id)
      if (isAuthExpiredMessage(message)) {
        setNotice('登录已过期，请使用 /login 重新登录')
        await refreshSnapshot().catch(() => {})
      }
    } finally {
      setIsSending(false)
    }
  }

  function promptWithActiveModes(content: string): string {
    const trimmed = content.trim()
    if (!trimmed || trimmed.startsWith('/')) return trimmed
    if (goalModeEnabled) {
      return `请把以下内容作为当前目标持续推进直到完成：${trimmed}`
    }
    if (planModeEnabled) {
      return `请先制定实施计划，不要直接修改文件：${trimmed}`
    }
    return trimmed
  }

  function enqueuePromptContent(content: string, targetSession = activeSession, images: ImageAttachment[] = []) {
    const trimmed = promptWithActiveModes(content) || (images.length > 0 ? '请分析这些图片' : '')
    if (!trimmed) return
    setQueuedPrompts(current => [
      ...current,
      {
        id: `q-${Date.now()}-${current.length}`,
        content: trimmed,
        images,
        sessionId: targetSession.id,
        sessionTitle: targetSession.title,
        createdAt: Date.now(),
      },
    ])
    setQueuePanelOpen(true)
    setPrompt('')
    setImageAttachments([])
  }

  useEffect(() => {
    if (isSending || queuedPrompts.length === 0) return
    const [nextPrompt, ...rest] = queuedPrompts
    setQueuedPrompts(rest)
    const targetSession =
      sessions.find(session => session.id === nextPrompt.sessionId) ??
      activeSession
    void submitPromptContent(nextPrompt.content, targetSession, nextPrompt.images)
  }, [activeSession, isSending, queuedPrompts, sessions])

  async function handleLocalSlashCommand(content: string): Promise<boolean> {
    const parsed = parseSlashCommand(content)
    if (!parsed) return false

    const openSettingsCommands = new Map<string, SettingsSection>([
      ['advisor', 'personalization'],
      ['agents', 'tools'],
      ['color', 'appearance'],
      ['config', 'profile'],
      ['config-server', 'profile'],
      ['default-model', 'profile'],
      ['effort', 'profile'],
      ['fast', 'profile'],
      ['ide', 'environment'],
      ['model', 'profile'],
      ['output-style', 'appearance'],
      ['permissions', 'profile'],
      ['plugin', 'tools'],
      ['plugins', 'tools'],
      ['privacy-settings', 'profile'],
      ['rate-limit-options', 'general'],
      ['remote', 'remote'],
      ['remote-env', 'remote'],
      ['reload-plugins', 'tools'],
      ['sandbox', 'profile'],
      ['statusline', 'appearance'],
      ['terminal-setup', 'environment'],
      ['theme', 'appearance'],
      ['update-config', 'profile'],
      ['usage', 'general'],
      ['vim', 'appearance'],
    ])

    if (parsed.name === 'clear' || parsed.name === 'reset' || parsed.name === 'new') {
      setMessages(() => [])
      setPrompt('')
      return true
    }

    if (parsed.name === 'compact') {
      setMessages(() => [])
      setSnapshot(current => ({
        ...current,
        sessions: current.sessions.map(session =>
          session.id === activeSession.id
            ? {
                ...session,
                context_used: Math.min(session.context_limit, Math.ceil(session.context_used * 0.12)),
              }
            : session,
        ),
      }))
      setPrompt('')
      return true
    }

    if (parsed.name === 'add-dir') {
      if (!parsed.args) {
        addSystemMessage('用法：/add-dir 路径')
        setPrompt('')
        return true
      }
      setPrompt('')
      try {
        const project = await safeInvoke<ProjectEntry>('add_project_path', {
          path: parsed.args,
          basePath: activeProjectPathForRequest,
        })
        await activateProject(project)
      } catch (error) {
        addSystemMessage(error instanceof Error ? error.message : String(error))
      }
      return true
    }

    if (parsed.name === 'branch' || parsed.name === 'fork') {
      const title = parsed.args || `${activeSession.title} 分支`
      setPrompt('')
      try {
        const session = await safeInvoke<Session>('start_session', {
          title,
          projectPath: activeSession.project_path || activeProjectPathForRequest,
        })
        setSnapshot(current => ({ ...current, sessions: [session, ...current.sessions] }))
        openSession(session)
        setMessagesBySession(current => ({
          ...current,
          [session.id]: [],
        }))
      } catch (error) {
        addSystemMessage(error instanceof Error ? error.message : String(error))
      }
      return true
    }

    if (parsed.name === 'btw') {
      if (!parsed.args) {
        addSystemMessage('用法：/btw 旁支问题')
        setPrompt('')
        return true
      }
      setPrompt('')
      try {
        const session = await safeInvoke<Session>('start_session', {
          title: `旁支：${parsed.args.slice(0, 24)}`,
          projectPath: activeSession.project_path || activeProjectPathForRequest,
        })
        setSnapshot(current => ({ ...current, sessions: [session, ...current.sessions] }))
        openSession(session)
        await submitPromptContent(parsed.args, session)
      } catch (error) {
        addSystemMessage(error instanceof Error ? error.message : String(error))
      }
      return true
    }

    if (parsed.name === 'memory') {
      setActiveView('settings')
      setSettingsSection('personalization')
      setPrompt('')
      void refreshMemoryDocument()
      return true
    }

    if (parsed.name === 'plan') {
      setCenterPanel('thinking')
      setPrompt('')
      if (parsed.args && parsed.args !== 'open') {
        await submitPromptContent(`请先制定实施计划，不要直接修改文件：${parsed.args}`)
      } else {
        addLocalResultMessage('已切换到计划视图')
      }
      return true
    }

    if (parsed.name === 'tasks' || parsed.name === 'bashes') {
      setCenterPanel('thinking')
      await refreshBackendTasks()
      return true
    }

    if (parsed.name === 'files') {
      setPrompt('')
      setActiveView('chat')
      setCenterPanel('editing')
      await refreshProjectDirectory(parsed.args.trim())
      return true
    }

    if (parsed.name === 'feedback' || parsed.name === 'bug') {
      setPrompt('')
      const description = parsed.args || window.prompt('描述你要反馈的问题', '') || ''
      if (!description.trim()) {
        addLocalResultMessage('已取消反馈')
        return true
      }
      try {
        const feedbackId = await safeInvoke<string>('submit_feedback', {
          description,
          projectPath: activeProjectPathForRequest || activeSession.project_path,
          messages: messages.slice(-20),
        })
        addLocalResultMessage(`反馈已提交，ID：${feedbackId}`)
      } catch (error) {
        addLocalResultMessage(error instanceof Error ? error.message : String(error))
      }
      return true
    }

    if (parsed.name === 'config-server') {
      setPrompt('')
      const rawValue = parsed.args || window.prompt('输入后端基础地址', FIXED_BACKEND_URL) || ''
      if (!rawValue.trim()) {
        addLocalResultMessage('已取消配置后端地址')
        return true
      }
      try {
        const normalized = await safeInvoke<string>('save_backend_base_url', { rawValue })
        addLocalResultMessage(`后端地址已更新：${normalized}。如果地址发生变化，旧登录态已清除，请重新登录。`)
        await refreshSnapshot()
      } catch (error) {
        addLocalResultMessage(error instanceof Error ? error.message : String(error))
      }
      return true
    }

    if (
      parsed.name === 'cost' ||
      parsed.name === 'context' ||
      parsed.name === 'doctor' ||
      parsed.name === 'extra-usage' ||
      parsed.name === 'model-list' ||
      parsed.name === 'model-reflex' ||
      parsed.name === 'release-notes' ||
      parsed.name === 'reload-plugins' ||
      parsed.name === 'openterminal' ||
      parsed.name === 'open-terminal' ||
      parsed.name === 'stats' ||
      parsed.name === 'status' ||
      parsed.name === 'stickers' ||
      parsed.name === 'version'
    ) {
      await runBackendLocalCommand(parsed.name, parsed.args)
      if (parsed.name === 'reload-plugins') {
        await refreshSnapshot()
        await refreshToolCatalog()
      }
      return true
    }

    if (parsed.name === 'help') {
      addLocalResultMessage(
        slashCommands.map(command => `/${command.name}  ${command.description}`).join('\n') ||
          '暂无可用命令',
      )
      setPrompt('')
      return true
    }

    if (parsed.name === 'copy') {
      const assistantMessages = messages.filter(message => message.role === 'assistant')
      const offset = parsed.args ? Number.parseInt(parsed.args, 10) : 1
      if (!Number.isInteger(offset) || offset < 1 || String(offset) !== (parsed.args || '1')) {
        addSystemMessage('用法：/copy [N]，N 为 1、2、3...')
        setPrompt('')
        return true
      }
      const target = assistantMessages[assistantMessages.length - offset]
      if (!target) {
        addSystemMessage('没有可复制的回复')
        setPrompt('')
        return true
      }
      await navigator.clipboard?.writeText(target.content)
      addSystemMessage(offset === 1 ? '已复制最新回复' : `已复制倒数第 ${offset} 条回复`)
      setPrompt('')
      return true
    }

    if (parsed.name === 'diff') {
      setReviewOpen(true)
      setPrompt('')
      return true
    }

    if (parsed.name === 'review') {
      setReviewOpen(true)
      setPrompt('')
      if (parsed.args) {
        await submitPromptContent(`请审查：${parsed.args}`)
      } else if (recentChanges.length === 0) {
        addLocalResultMessage('已打开 Review，当前没有可审查的近期更改')
      }
      return true
    }

    if (parsed.name === 'security-review') {
      setReviewOpen(true)
      setPrompt('')
      await submitPromptContent(
        parsed.args
          ? `请对当前改动执行安全审查：${parsed.args}`
          : '请对当前分支待提交改动执行安全审查',
      )
      return true
    }

    if (parsed.name === 'rewind' || parsed.name === 'checkpoint') {
      setReviewOpen(true)
      addLocalResultMessage(
        recentChanges.length > 0
          ? '已打开 Review，可在右侧选择需要 Revert 的更改'
          : '暂无可 Revert 的更改记录',
      )
      setPrompt('')
      return true
    }

    if (parsed.name === 'rename') {
      if (!parsed.args) {
        addSystemMessage('用法：/rename 新标题')
        setPrompt('')
        return true
      }
      setSnapshot(current => ({
        ...current,
        sessions: current.sessions.map(session =>
          session.id === activeSession.id ? { ...session, title: parsed.args } : session,
        ),
      }))
      safeInvoke<Session[]>('rename_session', {
        sessionId: activeSession.id,
        title: parsed.args,
      })
        .then(sessions => {
          setSnapshot(current => ({ ...current, sessions }))
        })
        .catch(error => {
          addSystemMessage(error instanceof Error ? error.message : String(error))
        })
      setPrompt('')
      return true
    }

    if (parsed.name === 'export') {
      const exported = [
        `# ${activeSession.title}`,
        '',
        `Session: ${activeSession.id}`,
        '',
        ...messages.map(message => `## ${message.role}\n\n${message.content}`),
      ].join('\n')
      if (parsed.args) {
        try {
          const path = await safeInvoke<string>('export_session_text', {
            fileName: parsed.args,
            projectPath: activeSession.project_path || activeProjectPathForRequest,
            content: exported,
          })
          addLocalResultMessage(`对话已导出到：${path}`)
        } catch (error) {
          addLocalResultMessage(error instanceof Error ? error.message : String(error))
        }
        setPrompt('')
        return true
      }
      await navigator.clipboard?.writeText(exported)
      addLocalResultMessage('当前会话已复制到剪贴板')
      setPrompt('')
      return true
    }

    if (parsed.name === 'mobile' || parsed.name === 'ios' || parsed.name === 'android') {
      setActiveView('settings')
      setSettingsSection('remote')
      setPrompt('')
      return true
    }

    if (parsed.name === 'upgrade') {
      setPrompt('')
      window.open('https://spark-ai.top/upgrade/max', '_blank', 'noopener,noreferrer')
      addLocalResultMessage('已打开 Spark Code 升级页面')
      return true
    }

    if (parsed.name === 'desktop' || parsed.name === 'app') {
      setPrompt('')
      addLocalResultMessage('当前已经在 Spark Code.app 中')
      return true
    }

    if (parsed.name === 'resume' || parsed.name === 'continue') {
      const target = parsed.args
        ? sessions.find(session =>
            session.id.includes(parsed.args) ||
            session.title.toLowerCase().includes(parsed.args.toLowerCase()),
          )
        : null
      if (target) {
        openSession(target)
      } else {
        addLocalResultMessage(
          sessions
            .slice(0, 12)
            .map(session => `${shortId(session.id)}  ${session.title}`)
            .join('\n') || '暂无可恢复会话',
        )
      }
      setPrompt('')
      return true
    }

    if (parsed.name === 'exit' || parsed.name === 'quit') {
      setPrompt('')
      try {
        await safeInvoke<string>('close_app')
      } catch {
        addSystemMessage('当前环境不支持关闭窗口')
      }
      return true
    }

    if (parsed.name === 'skills' || parsed.name === 'mcp') {
      setActiveView('settings')
      setSettingsSection('tools')
      setPrompt('')
      return true
    }

    if (parsed.name === 'login' || parsed.name === 'logout') {
      setActiveView('settings')
      setPrompt('')
      if (parsed.name === 'login') {
        void handleStartLogin()
      } else {
        void handleSparkLogout()
      }
      return true
    }

    if (parsed.name === 'usage') {
      setActiveView('settings')
      setSettingsSection('general')
      await runBackendLocalCommand('stats', parsed.args)
      return true
    }

    const settingsTarget = openSettingsCommands.get(parsed.name)
    if (settingsTarget) {
      setActiveView('settings')
      setSettingsSection(settingsTarget)
      setPrompt('')
      return true
    }

    return false
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const cursor = event.currentTarget.selectionStart ?? promptCursor
    const mentionRange = fileMentionRanges(prompt).find(range => cursor > range.start && cursor <= range.end)
    if (event.key === 'Backspace' && mentionRange && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
      event.preventDefault()
      removeFileMention(mentionRange.start, mentionRange.end)
      return
    }

    if (fileMentionPanelOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveFileSuggestionIndex(index => (index + 1) % fileSuggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveFileSuggestionIndex(index =>
          index === 0 ? fileSuggestions.length - 1 : index - 1,
        )
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const file = fileSuggestions[activeFileSuggestionIndex]
        if (file) {
          event.preventDefault()
          insertFileMention(file)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setFileSuggestions([])
        return
      }
    }

    if (slashCommandPanelOpen) {
      if (filteredSlashCommands.length > 0 && event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveSlashCommandIndex(index => (index + 1) % filteredSlashCommands.length)
        return
      }
      if (filteredSlashCommands.length > 0 && event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveSlashCommandIndex(index =>
          index === 0 ? filteredSlashCommands.length - 1 : index - 1,
        )
        return
      }
      if (filteredSlashCommands.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) {
        const command = filteredSlashCommands[activeSlashCommandIndex]
        if (!command) return
        event.preventDefault()
        insertSlashCommand(command)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setPrompt('')
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  async function handlePromptSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = prompt.trim()
    if (!content && imageAttachments.length === 0) return
    if (isSending) {
      enqueuePromptContent(content, activeSession, imageAttachments)
      return
    }
    if (await handleLocalSlashCommand(content)) return
    await submitPromptContent(promptWithActiveModes(content), activeSession, imageAttachments)
  }

  function editQueuedPrompt(item: QueuedPrompt) {
    setQueuedPrompts(current => current.filter(prompt => prompt.id !== item.id))
    setPrompt(item.content)
    setImageAttachments(item.images ?? [])
    setActiveSessionId(item.sessionId)
    openChat()
    setTimeout(() => {
      promptRef.current?.focus()
      promptRef.current?.setSelectionRange(item.content.length, item.content.length)
    }, 0)
  }

  async function handleCreateBranchSession() {
    setBranchMenuOpen(false)
    try {
      const session = await safeInvoke<Session>('start_session', {
        title: `${activeSession.title} 分支`,
        projectPath: activeSession.project_path || activeProjectPathForRequest,
      })
      setSnapshot(current => ({ ...current, sessions: [session, ...current.sessions] }))
      openSession(session)
      setMessagesBySession(current => ({
        ...current,
        [session.id]: [],
      }))
    } catch (error) {
      addSystemMessage(error instanceof Error ? error.message : String(error))
    }
  }

  function renderComposer(placement: 'center' | 'dock') {
    const centered = placement === 'center'
    const composerBoxClass = [
      'composer-box',
      isComposerDragging ? 'dragging' : '',
    ].filter(Boolean).join(' ')
    const currentModelName =
      selectedModel?.name ||
      snapshot.model.selected ||
      (isLoadingModelConfig ? '同步模型' : '选择模型')
    const modelDisabled = isSavingModel

    return (
      <form className={centered ? 'composer composer-center' : 'composer'} onSubmit={handlePromptSubmit}>
        {activeChangeCount > 0 ? (
          <section className="composer-change-card" aria-label="当前代码改动">
            <header className="composer-change-card-header">
              <div className="composer-change-icon" aria-hidden="true">
                <FilePenLine size={24} />
              </div>
              <div className="composer-change-title">
                <strong>已编辑 {activeChangeCount} 个文件</strong>
                <span>
                  <b className="added">+{changeLineStats.added}</b>
                  <b className="removed">-{changeLineStats.removed}</b>
                </span>
              </div>
              <div className="composer-change-actions">
                <button
                  disabled={revertingChangeId === '__all__'}
                  onClick={() => void handleRevertActiveChanges()}
                  type="button"
                >
                  {revertingChangeId === '__all__' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Undo2 size={16} aria-hidden="true" />}
                  撤销
                </button>
                <button className="primary" disabled={isSending} onClick={() => void handleReviewActiveChanges()} type="button">
                  审核
                </button>
              </div>
            </header>
            <div className="composer-change-files">
              {activeChanges.slice(0, 6).map(change => (
                <button
                  key={change.id}
                  onClick={() => {
                    void openProjectFile(change.path)
                  }}
                  title={change.summary || change.path}
                  type="button"
                >
                  <span>{change.path}</span>
                  <strong>
                    <b className="added">+{change.added_lines ?? 0}</b>
                    <b className="removed">-{change.removed_lines ?? 0}</b>
                  </strong>
                </button>
              ))}
            </div>
            {changeNotice ? <p className="composer-change-notice">{changeNotice}</p> : null}
          </section>
        ) : null}
        {renderPermissionPanel()}
        {renderQueuePanel()}
        <div
          className={composerBoxClass}
          onDragEnter={handleComposerDragEnter}
          onDragLeave={handleComposerDragLeave}
          onDragOver={handleComposerDragOver}
          onDrop={handleComposerDrop}
        >
          <label className="sr-only" htmlFor="prompt">输入请求</label>
          <textarea
            id="prompt"
            onKeyDown={handlePromptKeyDown}
            onPaste={event => {
              void handleComposerPaste(event)
            }}
            onChange={event => {
              setPrompt(event.target.value)
              setPromptCursor(event.target.selectionStart ?? event.target.value.length)
            }}
            onClick={updatePromptCursor}
            onSelect={updatePromptCursor}
            placeholder={centered ? '随心输入' : '输入请求'}
            ref={promptRef}
            rows={centered ? 4 : 2}
            value={prompt}
          />
          {fileMentionChips.length > 0 ? (
            <div className="mention-chip-row" aria-label="@ 文件引用">
              {fileMentionChips.map(chip => (
                <button
                  key={`${chip.start}-${chip.text}`}
                  onClick={() => removeFileMention(chip.start, chip.end)}
                  title="移除文件引用"
                  type="button"
                >
                  <AtSign size={13} aria-hidden="true" />
                  <span>{chip.text.slice(1)}</span>
                  <X size={12} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
          {imageAttachments.length > 0 ? (
            <div className="image-attachment-row" aria-label="图片附件">
              {imageAttachments.map(image => (
                <button
                  key={image.id}
                  onClick={() => setImageAttachments(current => current.filter(item => item.id !== image.id))}
                  title="移除图片"
                  type="button"
                >
                  <img alt="" src={imageAttachmentSrc(image)} />
                  <span>{image.name}</span>
                  <X size={12} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
          {slashCommandPanelOpen ? (
            <div className="slash-command-panel" role="listbox" aria-label="Slash commands">
              {filteredSlashCommands.length > 0 ? (
                filteredSlashCommands.map((command, index) => (
                  <button
                    aria-selected={index === activeSlashCommandIndex}
                    className={index === activeSlashCommandIndex ? 'active' : ''}
                    key={command.name}
                    onMouseDown={event => {
                      event.preventDefault()
                      insertSlashCommand(command)
                    }}
                    role="option"
                    type="button"
                  >
                    <span>
                      <strong>/{command.name}</strong>
                      <small>{command.description}</small>
                    </span>
                    <em>{command.category}</em>
                  </button>
                ))
              ) : (
                <div className="slash-command-empty">未读取到后端命令</div>
              )}
            </div>
          ) : null}
          {fileMentionPanelOpen ? (
            <div className="file-mention-panel" role="listbox" aria-label="@ 文件补全">
              {fileSuggestions.map((file, index) => (
                <button
                  aria-selected={index === activeFileSuggestionIndex}
                  className={index === activeFileSuggestionIndex ? 'active' : ''}
                  key={file.path}
                  onMouseDown={event => {
                    event.preventDefault()
                    insertFileMention(file)
                  }}
                  role="option"
                  type="button"
                >
                  <AtSign size={14} aria-hidden="true" />
                  <span>
                    <strong>{file.name}</strong>
                    <small>{file.path}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="composer-action-row">
            <div className="composer-tools" aria-label="快捷工具">
              <div className="tool-menu-control" onClick={event => event.stopPropagation()}>
                <button
                  aria-expanded={toolMenuOpen}
                  aria-label="添加"
                  className={toolMenuOpen ? 'active' : ''}
                  onClick={() => {
                    setPermissionMenuOpen(false)
                    setModelMenuOpen(false)
                    setProjectMenuOpen(false)
                    setModeMenuOpen(false)
                    setBranchMenuOpen(false)
                    setToolMenuOpen(value => !value)
                  }}
                  title="添加"
                  type="button"
                >
                  <Plus size={16} aria-hidden="true" />
                </button>
                {toolMenuOpen ? (
                  <div className="tool-menu-popover" role="menu">
                    <button
                      onClick={() => {
                        imageInputRef.current?.click()
                        setToolMenuOpen(false)
                      }}
                      type="button"
                    >
                      <Paperclip size={18} aria-hidden="true" />
                      <span>添加照片和文件</span>
                    </button>
                    <button
                      className={planModeEnabled ? 'enabled' : ''}
                      onClick={() => setPlanModeEnabled(value => !value)}
                      type="button"
                    >
                      <ListChecks size={18} aria-hidden="true" />
                      <span>计划模式</span>
                      <i aria-hidden="true" />
                    </button>
                    <button
                      className={goalModeEnabled ? 'enabled' : ''}
                      onClick={() => setGoalModeEnabled(value => !value)}
                      type="button"
                    >
                      <Target size={18} aria-hidden="true" />
                      <span>追求目标</span>
                      <i aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
              <input
                className="sr-only"
                multiple
                onChange={event => {
                  void handleDroppedFiles(event.target.files, { source: 'picker' })
                  event.target.value = ''
                }}
                ref={imageInputRef}
                type="file"
              />
              <div className="permission-control" onClick={event => event.stopPropagation()}>
                <button
                  aria-expanded={permissionMenuOpen}
                  className={permissionMenuOpen ? 'active' : ''}
                  onClick={() => {
                    setToolMenuOpen(false)
                    setModelMenuOpen(false)
                    setProjectMenuOpen(false)
                    setModeMenuOpen(false)
                    setBranchMenuOpen(false)
                    setPermissionMenuOpen(value => !value)
                  }}
                  type="button"
                >
                  <ShieldCheck size={16} aria-hidden="true" />
                  {permissionLabel(preferences.permission_mode)}
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                {permissionMenuOpen ? (
                  <div className="permission-menu" role="menu">
                    {permissionOptions.map(option => (
                      <button
                        className={preferences.permission_mode === option.id ? 'active' : ''}
                        key={option.id}
                        onClick={() => {
                          updatePreference('permission_mode', option.id)
                          setPermissionMenuOpen(false)
                        }}
                        type="button"
                      >
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="composer-submit-actions">
              <button
                aria-label="排队发送"
                className="secondary-button queue-button"
                disabled={!prompt.trim() && imageAttachments.length === 0}
                onClick={() => enqueuePromptContent(prompt, activeSession, imageAttachments)}
                title="排队发送"
                type="button"
              >
                <Archive size={16} aria-hidden="true" />
              </button>
              <div className="model-menu-control" onClick={event => event.stopPropagation()}>
                <button
                  aria-expanded={modelMenuOpen}
                  aria-haspopup="listbox"
                  className={modelMenuOpen ? 'active' : ''}
                  disabled={modelDisabled}
                  onClick={() => {
                    setToolMenuOpen(false)
                    setPermissionMenuOpen(false)
                    setProjectMenuOpen(false)
                    setModeMenuOpen(false)
                    setBranchMenuOpen(false)
                    setModelMenuOpen(value => {
                      const next = !value
                      if (next && snapshot.model.options.length === 0 && !isLoadingModelConfig) {
                        void refreshModelConfig()
                      }
                      return next
                    })
                  }}
                  type="button"
                >
                  <Cpu size={16} aria-hidden="true" />
                  <span>{currentModelName}</span>
                  <ChevronDown size={15} aria-hidden="true" />
                </button>
                {modelMenuOpen ? (
                  <div aria-busy={isLoadingModelConfig} className="model-menu-popover" role="listbox" aria-label="模型名称">
                    {hasModelOptions ? (
                      <>
                        {modelOptions.map(option => (
                          <button
                            aria-selected={snapshot.model.selected === option.id}
                            className={snapshot.model.selected === option.id ? 'active' : ''}
                            key={option.id}
                            onClick={() => {
                              void handleModelChange(option.id)
                            }}
                            role="option"
                            type="button"
                          >
                            <span className="model-option-check">
                              {snapshot.model.selected === option.id ? <Check size={16} aria-hidden="true" /> : null}
                            </span>
                            <span className="model-option-copy">
                              <strong>{option.name}</strong>
                              {option.description ? <small>{option.description}</small> : null}
                            </span>
                          </button>
                        ))}
                        <button
                          className="model-sync-option"
                          disabled={isLoadingModelConfig}
                          onClick={() => {
                            void refreshModelConfig()
                          }}
                          role="option"
                          type="button"
                        >
                          <span className="model-option-check">
                            {isLoadingModelConfig ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Cpu size={15} aria-hidden="true" />}
                          </span>
                          <span className="model-option-copy">
                            <strong>刷新模型列表</strong>
                            <small>{modelSyncError || '从后端重新同步'}</small>
                          </span>
                        </button>
                      </>
                    ) : isLoadingModelConfig ? (
                      <button className="active" disabled role="option" type="button">
                        <span className="model-option-check">
                          <Loader2 className="spin" size={16} aria-hidden="true" />
                        </span>
                        <span className="model-option-copy">
                          <strong>正在同步模型</strong>
                          <small>后端模型列表同步后会自动显示</small>
                        </span>
                      </button>
                    ) : (
                      <button
                        className="active"
                        onClick={() => {
                          void refreshModelConfig()
                        }}
                        role="option"
                        type="button"
                      >
                        <span className="model-option-check">
                          <Cpu size={16} aria-hidden="true" />
                        </span>
                        <span className="model-option-copy">
                          <strong>从后端同步模型</strong>
                          <small>{modelSyncError || '点击从后端重新获取模型列表'}</small>
                        </span>
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
              <button className="send-button" disabled={!prompt.trim() && imageAttachments.length === 0} type="submit">
                {centered ? <ArrowUp size={21} aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
                {centered ? null : <span>{isSending ? '发送中' : '发送'}</span>}
              </button>
            </div>
          </div>
          <div className="composer-meta-row">
            <span>
              <ShieldCheck size={15} aria-hidden="true" />
              {permissionLabel(preferences.permission_mode)}
            </span>
            {queuedPrompts.length > 0 ? (
              <span>
                <Archive size={15} aria-hidden="true" />
                队列 {queuedPrompts.length}
              </span>
            ) : null}
          </div>
        </div>
        {centered ? (
          <div className="composer-context-row" aria-label="当前上下文">
            <div className="project-menu-control" onClick={event => event.stopPropagation()}>
              <button
                aria-expanded={projectMenuOpen}
                aria-haspopup="menu"
                aria-label={activeProjectName}
                className={projectMenuOpen ? 'project-context-button active' : 'project-context-button'}
                onClick={() => {
                  setToolMenuOpen(false)
                  setPermissionMenuOpen(false)
                  setModelMenuOpen(false)
                  setModeMenuOpen(false)
                  setBranchMenuOpen(false)
                  setProjectSearch('')
                  setProjectMenuOpen(value => !value)
                }}
                type="button"
              >
                <FolderSymlink size={16} aria-hidden="true" />
                <span>{activeProjectName}</span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>
              {projectMenuOpen ? (
                <div className="project-menu-popover" role="menu" aria-label="项目文件夹">
                  <label className="project-menu-search">
                    <Search size={15} aria-hidden="true" />
                    <input
                      autoFocus
                      onChange={event => setProjectSearch(event.target.value)}
                      placeholder="搜索项目"
                      type="search"
                      value={projectSearch}
                    />
                  </label>
                  {filteredProjectOptions.map(project => {
                    const selected = project.path === activeProjectPathForRequest
                    return (
                      <button
                        className={selected ? 'active' : ''}
                        key={project.path}
                        onClick={() => {
                          void handleSelectProject(project)
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <FolderSymlink size={16} aria-hidden="true" />
                        <span>
                          <strong>{project.name}</strong>
                          <small>{project.path}</small>
                        </span>
                        {selected ? <Check size={15} aria-hidden="true" /> : null}
                      </button>
                    )
                  })}
                  <button
                    className="project-menu-add"
                    onClick={() => {
                      void handleAddProjectPath()
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Plus size={16} aria-hidden="true" />
                    <span>
                      <strong>新增项目文件夹</strong>
                      <small>输入本地项目路径</small>
                    </span>
                  </button>
                  <button
                    className={noProjectSelected ? 'active project-menu-none' : 'project-menu-none'}
                    onClick={() => {
                      setActiveProjectPath(NO_PROJECT_SELECTION)
                      persistActiveProjectPath(NO_PROJECT_SELECTION)
                      void syncActiveProjectToBackend('')
                      setProjectMenuOpen(false)
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <FolderSymlink size={16} aria-hidden="true" />
                    <span>
                      <strong>不使用项目</strong>
                      <small>仅使用当前会话上下文</small>
                    </span>
                    {noProjectSelected ? <Check size={15} aria-hidden="true" /> : null}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="context-menu-control" onClick={event => event.stopPropagation()}>
              <button
                aria-expanded={modeMenuOpen}
                onClick={() => {
                  setToolMenuOpen(false)
                  setPermissionMenuOpen(false)
                  setModelMenuOpen(false)
                  setProjectMenuOpen(false)
                  setBranchMenuOpen(false)
                  setModeMenuOpen(value => !value)
                }}
                type="button"
              >
                <TerminalSquare size={16} aria-hidden="true" />
                <span>{activeProjectMode || '编写模式'}</span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>
              {modeMenuOpen ? (
                <div className="context-menu-popover" role="menu">
                  {([
                    ['write', '编写模式'],
                    ['plan', '计划模式'],
                    ['goal', '目标模式'],
                  ] as Array<[ComposerMode, string]>).map(([mode, label]) => (
                    <button
                      className={activeProjectMode === label ? 'active' : ''}
                      key={mode}
                      onClick={() => setComposerMode(mode)}
                      role="menuitem"
                      type="button"
                    >
                      <TerminalSquare size={15} aria-hidden="true" />
                      <span>{label}</span>
                      {activeProjectMode === label ? <Check size={14} aria-hidden="true" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="context-menu-control" onClick={event => event.stopPropagation()}>
              <button
                aria-expanded={branchMenuOpen}
                onClick={() => {
                  setToolMenuOpen(false)
                  setPermissionMenuOpen(false)
                  setModelMenuOpen(false)
                  setProjectMenuOpen(false)
                  setModeMenuOpen(false)
                  setBranchMenuOpen(value => !value)
                }}
                title="Git 分支"
                type="button"
              >
                <GitBranch size={16} aria-hidden="true" />
                <span>{activeProjectGitBranch || '无分支'}</span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>
              {branchMenuOpen ? (
                <div className="context-menu-popover branch-popover" role="menu">
                  <button
                    onClick={() => {
                      setBranchMenuOpen(false)
                      void refreshProjectMetadata()
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <GitBranch size={15} aria-hidden="true" />
                    <span>刷新当前分支</span>
                  </button>
                  <button onClick={handleCreateBranchSession} role="menuitem" type="button">
                    <Plus size={15} aria-hidden="true" />
                    <span>从当前会话创建分支</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </form>
    )
  }

  function renderPermissionPanel() {
    const activeRequests = pendingPermissions.filter(request => request.session_id === activeSession.id)
    if (activeRequests.length === 0) return null

    return (
      <section className="permission-request-panel" aria-label="权限请求">
        {activeRequests.map(request => {
          const responding = respondingPermissionIds.has(request.id)
          const canAllowSession = request.suggestions.length > 0
          return (
            <article className="permission-request-item" key={request.id}>
              <ShieldCheck size={17} aria-hidden="true" />
              <div className="permission-request-copy">
                <strong>{request.tool_name} 需要权限</strong>
                <span>{request.message || request.description || '后端工具正在等待确认'}</span>
                {request.blocked_path ? <small>{request.blocked_path}</small> : null}
                <code>{compactPermissionInput(request.input)}</code>
              </div>
              <div className="permission-request-actions">
                <button
                  disabled={responding}
                  onClick={() => {
                    void respondToPermissionRequest(request, 'allow_once')
                  }}
                  type="button"
                >
                  允许一次
                </button>
                <button
                  disabled={responding || !canAllowSession}
                  onClick={() => {
                    void respondToPermissionRequest(request, 'allow_session')
                  }}
                  title={canAllowSession ? '本会话内保存该权限规则' : '后端没有返回可保存的会话规则'}
                  type="button"
                >
                  本会话允许
                </button>
                <button
                  className="danger"
                  disabled={responding}
                  onClick={() => {
                    void respondToPermissionRequest(request, 'deny')
                  }}
                  type="button"
                >
                  拒绝
                </button>
              </div>
            </article>
          )
        })}
      </section>
    )
  }

  function renderQueuePanel() {
    if (!queuePanelOpen || (!isSending && queuedPrompts.length === 0)) return null

    return (
      <section className="queue-panel" aria-label="待发送队列">
        <div className="queue-panel-header">
          {isSending ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}
          <strong>队列</strong>
          <span>{queuedPrompts.length > 0 ? `${queuedPrompts.length} 待发` : '发送中'}</span>
        </div>
        <div className="queue-list">
          {isSending ? (
            <article className="queue-item active">
              <div className="queue-rank">
                <Loader2 className="spin" size={14} aria-hidden="true" />
              </div>
              <div className="queue-content">
                <strong>正在发送</strong>
                <span>{activeSession.title}</span>
                <p>当前消息正在处理</p>
              </div>
            </article>
          ) : null}
          {queuedPrompts.map((item, index) => (
            <article className="queue-item" key={item.id}>
              <div className="queue-rank">{index + 1}</div>
              <div className="queue-content">
                <strong>{item.sessionTitle}</strong>
                <span>{shortId(item.sessionId)}{item.images.length > 0 ? ` · ${item.images.length} 张图片` : ''}</span>
                <p>{item.content}</p>
              </div>
              <button
                aria-label="编辑消息"
                onClick={() => editQueuedPrompt(item)}
                title="编辑消息"
                type="button"
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button
                aria-label="移出队列"
                onClick={() => setQueuedPrompts(current => current.filter(prompt => prompt.id !== item.id))}
                title="移出队列"
                type="button"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>
    )
  }

  function renderConversation() {
    const orderedMessages = orderedConversationMessages(visibleMessages)
    const hasStreamingAssistant = visibleMessages.some(message =>
      message.role === 'assistant' && message.id.startsWith('a-stream-'),
    )

    return (
      <>
        <div className="conversation-stream" aria-live="polite">
          {orderedMessages.length === 0 ? (
            <section className="workspace-empty">
              <h2>我们应该在 {activeProjectName} 中构建什么？</h2>
              {renderComposer('center')}
              <div className="home-suggestion-list" aria-label="建议">
                <button onClick={() => setPrompt('把 Spark Code 配对页补成二维码和 deep link')} type="button">
                  <MessageSquareText size={18} aria-hidden="true" />
                  <span>把 Spark Code 配对页补成二维码和 deep link</span>
                </button>
                <button onClick={() => setPrompt('补一个可直接跑的 Spark Code 最小客户端示例')} type="button">
                  <MessageSquareText size={18} aria-hidden="true" />
                  <span>补一个可直接跑的 Spark Code 最小客户端示例</span>
                </button>
                <button onClick={() => setPrompt('审查当前分支的未提交改动')} type="button">
                  <GitBranch size={18} aria-hidden="true" />
                  <span>审查当前分支的未提交改动</span>
                </button>
              </div>
            </section>
          ) : (
		            orderedMessages.map((message, index) => {
		              const streaming = message.role === 'assistant' && message.id === streamingMessageId
		              const thinking = streaming && message.content.startsWith('正在思考')
		              const terminal = shouldRenderAsTerminal(message)
		              const thinkingChain = Boolean(parseThinkingChain(message.content))
		              return (
                <div className="message-block" key={message.id}>
	                  {shouldShowIdleDivider(orderedMessages, index) ? (
                    <div className="conversation-idle-divider">
                      <span>{formatIdleDivider(messageCreatedAt(message))}</span>
                    </div>
                  ) : null}
                  <article className={`message-row ${message.role}${streaming ? ' streaming' : ''}${terminal ? ' terminal' : ''}`}>
                    <div className="message-card">
                      <span>{message.role === 'user' ? 'You' : 'Spark Code'}</span>
                      {renderMessageContent(message, thinking)}
                      {message.images?.length ? (
                        <div className="message-image-strip" aria-label="图片附件">
                          {message.images.map(image => (
                            <img
                              alt={image.name}
                              key={image.id}
                              onError={() => scrollConversationToBottom('auto')}
                              onLoad={() => scrollConversationToBottom('auto')}
                              src={imageAttachmentSrc(image)}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
	                    {!terminal && !thinkingChain ? <div className="message-actions">
                      <button
                        aria-label="复制"
                        onClick={() => {
                          void copyText(message.content, '消息')
                        }}
                        type="button"
                      >
                        <Copy size={15} aria-hidden="true" />
                      </button>
                      {message.role === 'user' ? (
                        <button
                          aria-label="编辑"
                          onClick={() => {
                            setPrompt(message.content)
                            setImageAttachments(message.images ?? [])
                            promptRef.current?.focus()
                          }}
                          type="button"
                        >
                          <Pencil size={15} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div> : null}
                  </article>
                </div>
              )
            })
          )}

          {isSending && !hasStreamingAssistant ? (
            <article className="message-row assistant">
              <div className="message-card">
                <span>Spark Code</span>
                <p className="thinking-text">正在思考{"\n"}</p>
              </div>
            </article>
          ) : null}
          <div className="conversation-scroll-anchor" ref={conversationEndRef} aria-hidden="true" />
        </div>
      </>
    )
  }

  function renderThinking() {
    const thinkingSteps = [
      {
        label: '理解请求',
        detail: prompt.trim() ? '已收到新的输入草稿' : '等待新的用户输入',
        active: Boolean(prompt.trim()),
      },
      {
        label: '规划操作',
        detail: activeChangeCount > 0 ? '已有可审核的代码改动' : '暂无待审核代码改动',
        active: activeChangeCount > 0,
      },
      {
        label: '执行工具',
        detail: isSending ? '正在等待执行结果' : '空闲',
        active: isSending,
      },
    ]

    return (
      <section className="process-panel">
        <div className="process-header">
          <BrainCircuit size={20} aria-hidden="true" />
          <div>
            <h2>思考过程</h2>
            <p>中间区域会集中展示当前任务的推理进度和工具调用。</p>
          </div>
        </div>
        <div className="process-list">
          {thinkingSteps.map(step => (
            <article className={step.active ? 'process-step active' : 'process-step'} key={step.label}>
              <span aria-hidden="true" />
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            </article>
          ))}
        </div>
        <div className="runtime-event-list" aria-label="真实后端事件">
          <strong>后端事件</strong>
          {runtimeEvents.length > 0 ? (
            runtimeEvents.map(event => (
              <article className={`runtime-event ${event.tone}`} key={event.id}>
                <span>{event.label}</span>
                <p>{event.value}</p>
              </article>
            ))
          ) : (
            <div className="empty-compact">暂无后端事件</div>
          )}
        </div>
      </section>
    )
  }

  function renderEditing() {
    const hasDirtyFile = Boolean(activeFileDocument && fileDraft !== activeFileDocument.content)
    return (
      <section className="editing-panel">
        <div className="process-header">
          <FilePenLine size={20} aria-hidden="true" />
          <div>
            <h2>文件和操作</h2>
            <p>{activeProjectName} · {directoryPath || '项目根目录'}</p>
          </div>
          <div className="directory-actions">
            <button className="secondary-button" onClick={() => void refreshProjectDirectory('')} type="button">
              <FolderTree size={14} aria-hidden="true" />
              根目录
            </button>
            <button className="secondary-button" onClick={createProjectFileDraft} type="button">
              <Plus size={14} aria-hidden="true" />
              新建文件
            </button>
            <button className="secondary-button" onClick={() => void createProjectDirectory()} type="button">
              <FolderTree size={14} aria-hidden="true" />
              新建文件夹
            </button>
          </div>
        </div>
        <div className="directory-panel">
          <div className="directory-list">
            {directoryPath ? (
              <button
                className="directory-item"
                onClick={() => void refreshProjectDirectory(parentDirectory(directoryPath))}
                type="button"
              >
                <FolderTree size={17} aria-hidden="true" />
                <div>
                  <strong>..</strong>
                  <span>返回上级目录</span>
                </div>
              </button>
            ) : null}
            {isLoadingDirectory ? (
              <div className="empty-compact">正在读取目录</div>
            ) : directoryEntries.length > 0 ? (
              directoryEntries.map(entry => (
                <article
                  className={entry.is_dir ? 'directory-item directory-folder' : 'directory-item'}
                  key={`${entry.is_dir ? 'd' : 'f'}-${entry.path}`}
                >
                  <button
                    className="directory-open"
                    onClick={() => {
                      if (entry.is_dir) {
                        void refreshProjectDirectory(entry.path)
                      } else {
                        void openProjectFile(entry.path)
                      }
                    }}
                    type="button"
                  >
                    {entry.is_dir ? <FolderTree size={17} aria-hidden="true" /> : <FileText size={17} aria-hidden="true" />}
                    <div>
                      <strong>{entry.name}</strong>
                      <span>{entry.path}</span>
                      <p>{entry.is_dir ? '文件夹' : formatFileSize(entry.size)}</p>
                    </div>
                  </button>
                  <button
                    aria-label={`重命名 ${entry.name}`}
                    className="directory-row-action"
                    onClick={() => void renameProjectEntry(entry)}
                    title="重命名"
                    type="button"
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  {entry.is_dir ? (
                    <button
                      aria-label={`删除文件夹 ${entry.name}`}
                      className="directory-row-action danger"
                      onClick={() => void deleteProjectDirectory(entry)}
                      title="删除空文件夹"
                      type="button"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </article>
              ))
            ) : (
              <div className="empty-compact">目录为空</div>
            )}
          </div>
          <div className="file-editor-panel">
            <header>
              <div>
                <strong>{activeFileDocument?.path ?? '未打开文件'}</strong>
                <span>
                  {activeFileDocument
                    ? `${activeFileDocument.exists ? '已存在' : '新文件'} · ${formatFileSize(activeFileDocument.size)}`
                    : '从左侧目录选择文本文件'}
                </span>
              </div>
              <div className="file-editor-actions">
                <button
                  className="secondary-button"
                  disabled={!activeFileDocument?.exists || isSavingFileDocument || isLoadingFileDocument}
                  onClick={() => activeFileDocument && void renameProjectEntry(activeFileDocument)}
                  type="button"
                >
                  <Pencil size={14} aria-hidden="true" />
                  重命名
                </button>
                <button
                  className="secondary-button danger"
                  disabled={!activeFileDocument?.exists || isSavingFileDocument || isLoadingFileDocument}
                  onClick={() => void deleteActiveProjectFile()}
                  type="button"
                >
                  <Trash2 size={14} aria-hidden="true" />
                  删除
                </button>
                <button
                  className="secondary-button"
                  disabled={!activeFileDocument || isSavingFileDocument || isLoadingFileDocument || !hasDirtyFile}
                  onClick={() => void saveActiveProjectFile()}
                  type="button"
                >
                  {isSavingFileDocument ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                  保存
                </button>
              </div>
            </header>
            <textarea
              disabled={!activeFileDocument || isLoadingFileDocument || isSavingFileDocument}
              onChange={event => setFileDraft(event.target.value)}
              placeholder={isLoadingFileDocument ? '正在读取文件' : '打开或新建一个项目文件'}
              value={activeFileDocument ? fileDraft : ''}
            />
          </div>
        </div>
        {recentChanges.length > 0 ? (
          <div className="operation-list">
            {recentChanges.map(change => (
              <article className="operation-item" key={change.id}>
                <FileText size={17} aria-hidden="true" />
                <div>
                  <strong>{change.title}</strong>
                  <span>{change.path}</span>
                  <p>{change.summary}</p>
                </div>
                <button className="text-button" onClick={() => setReviewOpen(true)} type="button">
                  Review
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-compact">暂无正在编辑或操作的内容</div>
        )}
      </section>
    )
  }

  function renderSettingsSidebar() {
    return (
      <div className="settings-sidebar-content">
        <button
          className="settings-back-button"
          onClick={() => {
            setActiveView('chat')
            openChat()
          }}
          type="button"
        >
          <ArrowLeft size={20} aria-hidden="true" />
          <span>返回应用</span>
        </button>
        <label className="settings-search">
          <Search size={18} aria-hidden="true" />
          <input
            onChange={event => setSettingsQuery(event.target.value)}
            placeholder="搜索设置..."
            type="search"
            value={settingsQuery}
          />
        </label>
        <div className="settings-nav-groups">
          {visibleSettingsGroups.map(group => (
            <section className="settings-nav-group" key={group.title}>
              <span>{group.title}</span>
              {group.items.map(item => (
                <button
                  className={activeSettingsSection === item.id ? 'active' : ''}
                  key={item.id}
                  onClick={() => setSettingsSection(item.id)}
                  type="button"
                >
                  {item.icon}
                  <strong>{item.label}</strong>
                </button>
              ))}
            </section>
          ))}
        </div>
      </div>
    )
  }

  function renderSettings() {
    const settingsMeta: Record<SettingsSection, { title: string; description: string }> = {
      general: {
        title: '常规',
        description: '项目、运行时和主偏好设置。',
      },
      appearance: {
        title: '外观',
        description: '界面密度和侧边栏显示偏好。',
      },
      profile: {
        title: '配置',
        description: 'Spark 用户、模型和权限配置。',
      },
      personalization: {
        title: '个性化',
        description: '使用真实记忆文件管理长期偏好。',
      },
      tools: {
        title: '工具',
        description: `System Tools ${tools.length} 个，Skills ${skills.length} 个，MCP 服务器 ${mcpServers.length} 个。`,
      },
      remote: {
        title: '远程控制',
        description: remoteDevice.bound ? displayValue(remoteDevice.client_name, '当前设备已绑定') : '绑定 Remote 设备和启动偏好。',
      },
      environment: {
        title: '环境',
        description: `本地后端：${displayValue(backendRuntime.local_url)}`,
      },
      worktree: {
        title: '工作树',
        description: `当前项目：${activeProjectName}`,
      },
      archived: {
        title: '已归档对话',
        description: `${archivedSessions.length} 个本机归档对话。`,
      },
    }
    const emptyOnlySettings = new Set<SettingsSection>([
      'appearance',
      'archived',
    ])
    const renderSkillRow = (skill: SkillEntry) => (
      <article className="resource-row" key={skill.id}>
        <Sparkles size={15} aria-hidden="true" />
        <span>
          <strong>{skill.name}</strong>
          <small>{sourceLabel(skill.source)} · {skill.path}</small>
          {skill.description ? <p>{skill.description}</p> : null}
        </span>
      </article>
    )
    const renderMcpRow = (server: McpServerEntry) => (
      <article className={server.enabled ? 'resource-row enabled' : 'resource-row'} key={server.id}>
        <ServerCog size={15} aria-hidden="true" />
        <span>
          <strong>{server.name}</strong>
          <small>{sourceLabel(server.source)} · {server.transport}</small>
          <p>{server.url ?? server.command ?? '未配置启动命令'}</p>
        </span>
        <em>{server.enabled ? '启用' : '停用'}</em>
      </article>
    )
    const renderToolRow = (tool: ToolEntry) => (
      <article className={tool.enabled ? 'resource-row tool-row enabled' : 'resource-row tool-row'} key={tool.name}>
        <Cpu size={15} aria-hidden="true" />
        <span>
          <strong>{tool.name}</strong>
          <small>{tool.category} · {toolSourceLabel(tool)} · {toolReadModeLabel(tool)}</small>
          {tool.description ? <p>{tool.description}</p> : null}
        </span>
        <em>{tool.should_defer ? '按需' : tool.enabled ? '启用' : '停用'}</em>
      </article>
    )

    return (
      <section className="settings-workspace">
        <div className="settings-grid" data-section={activeSettingsSection}>
          {emptyOnlySettings.has(activeSettingsSection) ? (
            <section className="settings-section settings-empty-section">
              <div className="settings-heading">
                <Settings2 size={19} aria-hidden="true" />
                <div>
                  <h3>{settingsMeta[activeSettingsSection].title}</h3>
                  <p>{settingsMeta[activeSettingsSection].description}</p>
                </div>
              </div>
              {activeSettingsSection === 'appearance' ? (
                <>
                  <div className="permission-segment" role="group" aria-label="界面密度">
                    <button
                      className={uiDensity === 'compact' ? 'active' : ''}
                      onClick={() => setUiDensity('compact')}
                      type="button"
                    >
                      <strong>紧凑</strong>
                      <span>更接近当前 Codex 输入密度</span>
                    </button>
                    <button
                      className={uiDensity === 'comfortable' ? 'active' : ''}
                      onClick={() => setUiDensity('comfortable')}
                      type="button"
                    >
                      <strong>舒适</strong>
                      <span>增大消息和设置间距</span>
                    </button>
                  </div>
                  <SettingToggle
                    checked={!sessionListCollapsed}
                    description="控制左侧项目和会话树是否展开"
                    label="显示会话列表"
                    onChange={value => setSessionListCollapsed(!value)}
                  />
                </>
              ) : null}
              {activeSettingsSection === 'archived' ? (
                <div className="project-list">
                  {archivedSessions.length > 0 ? archivedSessions.map(entry => (
                    <article className="project-list-item" key={entry.session.id}>
                      <Archive size={17} aria-hidden="true" />
                      <div>
                        <strong>{entry.session.title}</strong>
                        <span>{formatIdleDivider(entry.archivedAt)} · {entry.messages.length} 条消息</span>
                      </div>
                      <button className="text-button" onClick={() => handleRestoreArchivedSession(entry)} type="button">
                        打开
                      </button>
                      <button className="text-button danger" onClick={() => handleDeleteArchivedSession(entry)} type="button">
                        删除
                      </button>
                    </article>
                  )) : (
                    <div className="empty-compact">暂无归档对话</div>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="settings-section profile-section pane-profile">
            <div className="settings-heading">
              <ShieldCheck size={19} aria-hidden="true" />
              <div>
                <h3>Spark 用户</h3>
                <p>{sparkUser.logged_in ? sparkUserSecondary(sparkUser) : '未登录，请在设置中重新登录。'}</p>
              </div>
            </div>
            <div className="profile-card">
              <div className={sparkUser.logged_in ? 'profile-avatar online' : 'profile-avatar'} aria-hidden="true">
                {sparkUser.avatar_url ? (
                  <img alt="" src={sparkUser.avatar_url} />
                ) : (
                  (sparkUser.email ?? sparkUser.name ?? 'S').slice(0, 1).toUpperCase()
                )}
              </div>
              <div className="profile-main">
                <strong>{sparkUserPrimary(sparkUser)}</strong>
                <span>{sparkUser.logged_in ? sparkUserSecondary(sparkUser) : '登录后会同步真实邮箱和用户名'}</span>
              </div>
              <span className={sparkUser.logged_in ? 'status-pill online' : 'status-pill'}>
                {sparkUser.logged_in ? '已登录' : '未登录'}
              </span>
              <button className="secondary-button" disabled={isStartingLogin} onClick={handleStartLogin} type="button">
                {isStartingLogin ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
                {sparkUser.logged_in ? '重新登录' : '登录 Spark'}
              </button>
              {sparkUser.logged_in ? (
                <button className="secondary-button danger" disabled={isLoggingOut} onClick={handleSparkLogout} type="button">
                  {isLoggingOut ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
                  退出登录
                </button>
              ) : null}
            </div>
            <div className="oauth-hint">
              <strong>网页 OAuth 配置</strong>
              <p>在 Spark-EDU 创建 OAuth2 App，Redirect URI 填 <code>http://127.0.0.1:42872/spark/oauth/callback</code>，再把 <code>SPARK_OAUTH_CLIENT_ID</code> 写进 <code>~/.sparkc/spark.json</code> 的 <code>env</code>。如果是 confidential client，再加 <code>SPARK_OAUTH_CLIENT_SECRET</code>。</p>
            </div>
            <div className="settings-kv-grid">
              <div>
                <span>用户 ID</span>
                <strong>{compactValue(sparkUser.id)}</strong>
              </div>
              <div>
                <span>组织</span>
                <strong>{displayValue(sparkUser.organization_name ?? sparkUser.organization_id)}</strong>
              </div>
              <div>
                <span>订阅</span>
                <strong>{displayValue(sparkUser.billing_type)}</strong>
              </div>
            </div>
          </section>

          <section className="settings-section pane-general pane-worktree">
            <div className="settings-heading">
              <FolderSymlink size={19} aria-hidden="true" />
              <div>
                <h3>项目</h3>
                <p>切换或新增当前项目文件夹。</p>
              </div>
              <button
                className="secondary-button settings-heading-action"
                onClick={() => {
                  void handleAddProjectPath()
                }}
                type="button"
              >
                <Plus size={14} aria-hidden="true" />
                新增
              </button>
            </div>
            <div className="project-list">
              {projectOptions.map(project => {
                const isCurrentProject = project.path === activeProjectPathForRequest
                return (
                  <article className="project-list-item" key={project.path}>
                    <FolderSymlink size={17} aria-hidden="true" />
                    <div>
                      <strong>{project.name}</strong>
                      <span>{project.path}</span>
                    </div>
                    <button
                      className="text-button"
                      disabled={isCurrentProject}
                      onClick={() => {
                        void handleSelectProject(project)
                      }}
                      type="button"
                    >
                      {isCurrentProject ? '当前' : '切换'}
                    </button>
                    <button
                      aria-label={`移除项目 ${project.name}`}
                      className="text-button danger"
                      disabled={isCurrentProject}
                      onClick={() => handleRemoveProject(project)}
                      title={isCurrentProject ? '当前项目不能移除' : '移除项目'}
                      type="button"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      移除
                    </button>
                  </article>
                )
              })}
            </div>
          </section>

          <section className="settings-section runtime-section pane-general pane-environment">
            <div className="settings-heading">
              <ServerCog size={19} aria-hidden="true" />
              <div>
                <h3>后端运行时</h3>
                <p>本地服务、流式传输和上下文能力。</p>
              </div>
              <button
                className="secondary-button settings-heading-action"
                disabled={isRefreshingBackend}
                onClick={() => void refreshBackendRuntime()}
                type="button"
              >
                {isRefreshingBackend ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
                刷新
              </button>
            </div>
            <div className="runtime-strip">
              <div>
                <span>Local URL</span>
                <strong>{displayValue(backendRuntime.local_url)}</strong>
              </div>
              <div>
                <span>Stream</span>
                <strong>{backendRuntime.streaming_enabled ? '已开启' : '未开启'}</strong>
              </div>
              <div>
                <span>Context</span>
                <strong>{formatTokens(backendRuntime.context_limit)}</strong>
              </div>
              <div>
                <span>Auth Token</span>
                <strong>{compactValue(backendRuntime.auth_token)}</strong>
              </div>
            </div>
          </section>

          <section className="settings-section pane-general">
            <div className="settings-heading">
              <ArrowUp size={19} aria-hidden="true" />
              <div>
                <h3>检测更新</h3>
                <p>{updateStatus.detail}</p>
              </div>
              <button
                className="secondary-button settings-heading-action"
                disabled={isCheckingUpdate}
                onClick={() => void checkForUpdates(true)}
                type="button"
              >
                {isCheckingUpdate ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
                检测
              </button>
            </div>
            <div className="settings-kv-grid">
              <div><span>当前版本</span><strong>{updateStatus.current_version}</strong></div>
              <div><span>当前提交</span><strong>{shortRevision(updateStatus.current_revision)}</strong></div>
              <div><span>远端提交</span><strong>{shortRevision(updateStatus.latest_revision)}</strong></div>
              <div><span>上次检测</span><strong>{formatUpdateCheckedAt(updateStatus.checked_at)}</strong></div>
            </div>
            {updateStatus.error ? <p className="settings-inline-error">{updateStatus.error}</p> : null}
          </section>

          <section className="settings-section pane-tools">
            <div className="settings-heading">
              <ServerCog size={19} aria-hidden="true" />
              <div>
                <h3>Skills & MCP</h3>
                <p>真实读取本机 Skills 和 MCP 服务器配置。</p>
              </div>
              <button
                className="secondary-button settings-heading-action"
                onClick={() => {
                  void refreshSnapshot()
                }}
                type="button"
              >
                <History size={14} aria-hidden="true" />
                刷新
              </button>
            </div>
            <div className="resource-split">
              <section>
                <strong>MCP 服务器 · {enabledMcpServerCount}/{mcpServers.length}</strong>
                <div className="resource-list compact">
                  {mcpServers.length > 0 ? mcpServers.map(renderMcpRow) : <div className="empty-compact">未读取到 MCP 服务器</div>}
                </div>
              </section>
              <section>
                <strong>Skills</strong>
                <div className="resource-list compact">
                  {skills.length > 0 ? skills.map(renderSkillRow) : <div className="empty-compact">未读取到 Skills</div>}
                </div>
              </section>
            </div>
          </section>

          <section className="settings-section pane-tools">
            <div className="settings-heading">
              <Cpu size={19} aria-hidden="true" />
              <div>
                <h3>系统 Tools</h3>
                <p>后端实时读取内置 system tools；MCP 服务器在上方单独展示，避免工具探测阻塞本地后端。</p>
              </div>
              <button
                className="secondary-button settings-heading-action"
                disabled={isLoadingTools}
                onClick={() => {
                  void refreshToolCatalog()
                }}
                type="button"
              >
                {isLoadingTools ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
                刷新
              </button>
            </div>
            <div className="settings-kv-grid">
              <div><span>全部</span><strong>{tools.length}</strong></div>
              <div><span>内置</span><strong>{builtinToolCount}</strong></div>
              <div><span>MCP 服务器</span><strong>{mcpServers.length}</strong></div>
            </div>
            <div className="resource-list tool-list">
              {tools.length > 0 ? tools.map(renderToolRow) : <div className="empty-compact">未读取到系统 Tools</div>}
            </div>
          </section>

          <section className="settings-section memory-section pane-personalization">
            <div className="settings-heading">
              <FileText size={19} aria-hidden="true" />
              <div>
                <h3>记忆</h3>
                <p>{memoryDocument?.path ?? 'Spark 记忆文件'}</p>
              </div>
              <button
                className="secondary-button settings-heading-action"
                disabled={isLoadingMemory}
                onClick={() => {
                  void refreshMemoryDocument()
                }}
                type="button"
              >
                {isLoadingMemory ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
                刷新
              </button>
            </div>
            <div className="memory-editor">
              <div className="memory-list" aria-label="记忆列表">
                {memoryEntries.length > 0 ? (
                  memoryEntries.map((entry, index) => (
                    <article className="memory-list-item" key={entry.id}>
                      <span>{index + 1}</span>
                      <textarea
                        aria-label={`记忆 ${index + 1}`}
                        disabled={isLoadingMemory || isSavingMemory}
                        onChange={event => updateMemoryEntry(entry.id, event.target.value)}
                        placeholder="输入一条记忆"
                        value={entry.text}
                      />
                      <button
                        aria-label="删除这条记忆"
                        disabled={isLoadingMemory || isSavingMemory}
                        onClick={() => deleteMemoryEntry(entry.id)}
                        type="button"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </article>
                  ))
                ) : (
                  <div className="memory-empty-row">空记忆</div>
                )}
              </div>
              <div className="memory-actions">
                <span>{memoryEntries.length > 0 ? `${memoryEntries.length} 条记忆` : '空记忆'}</span>
                <button
                  className="secondary-button"
                  disabled={isSavingMemory || isLoadingMemory}
                  onClick={addMemoryEntry}
                  type="button"
                >
                  <Plus size={15} aria-hidden="true" />
                  新增
                </button>
                <button
                  className="secondary-button"
                  disabled={isSavingMemory || isLoadingMemory}
                  onClick={handleSaveMemoryEntries}
                  type="button"
                >
                  {isSavingMemory ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                  保存
                </button>
                <button
                  className="secondary-button danger"
                  disabled={isSavingMemory || isLoadingMemory || !memoryDocument?.exists}
                  onClick={handleDeleteMemory}
                  type="button"
                >
                  <Trash2 size={15} aria-hidden="true" />
                  删除
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section pane-profile">
            <div className="settings-heading">
              <Cpu size={19} aria-hidden="true" />
              <div>
                <h3>模型名称</h3>
                <p>选择后立即保存，并用于后续会话。</p>
              </div>
              <button
                className="secondary-button settings-heading-action"
                disabled={isLoadingModelConfig}
                onClick={() => {
                  void refreshModelConfig()
                }}
                type="button"
              >
                {isLoadingModelConfig ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Cpu size={14} aria-hidden="true" />}
                同步
              </button>
            </div>
            <label className="settings-select-row" htmlFor="model-select">
              <span>模型名称</span>
              <select
                disabled={isSavingModel || isLoadingModelConfig || !hasModelOptions}
                id="model-select"
                onChange={event => handleModelChange(event.target.value)}
                value={modelSelectValue}
              >
                {!hasModelOptions ? (
                  <option value={snapshot.model.selected}>
                    {snapshot.model.selected || (isLoadingModelConfig ? '正在同步后端模型' : '暂无后端模型')}
                  </option>
                ) : modelOptions.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.description ? `${option.name} - ${option.description}` : option.name}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="settings-section pane-profile">
            <div className="settings-heading">
              <ShieldCheck size={19} aria-hidden="true" />
              <div>
                <h3>权限</h3>
                <p>会随请求同步到本地后端。</p>
              </div>
            </div>
            <div className="permission-segment" role="group" aria-label="权限模式">
              {permissionOptions.map(option => (
                <button
                  className={preferences.permission_mode === option.id ? 'active' : ''}
                  disabled={isSavingPreferences}
                  key={option.id}
                  onClick={() => updatePreference('permission_mode', option.id)}
                  type="button"
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section pane-remote">
            <div className="settings-heading">
              <ServerCog size={19} aria-hidden="true" />
              <div>
                <h3>远程控制</h3>
                <p>绑定 Remote 设备，并控制启动时是否自动启用。</p>
              </div>
            </div>
            <label className="settings-select-row" htmlFor="remote-startup-select">
              <span>启动时启用</span>
              <select
                disabled={isSavingPreferences}
                id="remote-startup-select"
                onChange={event => {
                  const value = event.target.value
                  updatePreference('remote_control_at_startup', value === 'default' ? null : value === 'true')
                }}
                value={
                  preferences.remote_control_at_startup === null
                    ? 'default'
                    : String(preferences.remote_control_at_startup)
                }
              >
                <option value="default">默认</option>
                <option value="true">开启</option>
                <option value="false">关闭</option>
              </select>
            </label>
            <div className="device-card">
              <div className="device-status">
                <Network size={18} aria-hidden="true" />
                <div>
                  <strong>{remoteDevice.status}</strong>
                  <span>{remoteDevice.bound ? displayValue(remoteDevice.client_name, '当前设备') : '输入绑定码完成设备绑定'}</span>
                </div>
              </div>
              <div className="device-bind-row">
                <input
                  aria-label="Remote 绑定码"
                  disabled={isBindingRemoteDevice || remoteDevice.bound}
                  onChange={event => setRemoteBindCode(event.target.value)}
                  placeholder="输入 Remote 绑定码"
                  value={remoteBindCode}
                />
                <button
                  className="secondary-button"
                  disabled={isBindingRemoteDevice || remoteDevice.bound || !remoteBindCode.trim()}
                  onClick={handleBindRemoteDevice}
                  type="button"
                >
                  {isBindingRemoteDevice ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
                  绑定设备
                </button>
              </div>
              {remoteDevice.bound ? (
                <button
                  className="secondary-button danger"
                  disabled={isBindingRemoteDevice}
                  onClick={handleUnbindRemoteDevice}
                  type="button"
                >
                  <X size={16} aria-hidden="true" />
                  解绑设备
                </button>
              ) : null}
            </div>
            <div className="settings-kv-grid two">
              <div>
                <span>Install ID</span>
                <strong>{compactValue(remoteDevice.install_id)}</strong>
              </div>
              <div>
                <span>Binding ID</span>
                <strong>{compactValue(remoteDevice.binding_id)}</strong>
              </div>
            </div>
          </section>

          <section className="settings-section pane-general">
            <div className="settings-heading">
              <Settings2 size={19} aria-hidden="true" />
              <div>
                <h3>主设置</h3>
                <p>这些配置会写入 Spark Code 本地配置。</p>
              </div>
            </div>
            <div className="setting-toggle-grid">
              <SettingToggle label="自动压缩" description="接近上下文上限时自动整理会话" checked={preferences.auto_compact_enabled} disabled={isSavingPreferences} onChange={value => updatePreference('auto_compact_enabled', value)} />
              <SettingToggle label="显示耗时" description="回复完成后显示本轮处理耗时" checked={preferences.show_turn_duration} disabled={isSavingPreferences} onChange={value => updatePreference('show_turn_duration', value)} />
              <SettingToggle label="终端进度条" description="运行命令时显示终端进度反馈" checked={preferences.terminal_progress_bar_enabled} disabled={isSavingPreferences} onChange={value => updatePreference('terminal_progress_bar_enabled', value)} />
              <SettingToggle label="文件检查点" description="为文件修改保留可回退记录" checked={preferences.file_checkpointing_enabled} disabled={isSavingPreferences} onChange={value => updatePreference('file_checkpointing_enabled', value)} />
              <SettingToggle label="遵守 Gitignore" description="读取和检索文件时跳过忽略路径" checked={preferences.respect_gitignore} disabled={isSavingPreferences} onChange={value => updatePreference('respect_gitignore', value)} />
              <SettingToggle label="复制完整回复" description="复制回复时保留完整内容" checked={preferences.copy_full_response} disabled={isSavingPreferences} onChange={value => updatePreference('copy_full_response', value)} />
              <SettingToggle label="自动连接 IDE" description="启动时自动连接可用 IDE" checked={preferences.auto_connect_ide} disabled={isSavingPreferences} onChange={value => updatePreference('auto_connect_ide', value)} />
              <SettingToggle label="自动安装 IDE 扩展" description="连接 IDE 时自动安装 Spark Code 扩展" checked={preferences.auto_install_ide_extension} disabled={isSavingPreferences} onChange={value => updatePreference('auto_install_ide_extension', value)} />
            </div>
          </section>
        </div>
        {notice ? <p className="notice">{notice}</p> : null}
      </section>
    )
  }

  function renderSearchModal() {
    if (!searchOpen) return null

    const hasResults = searchResults.sessions.length > 0

    return (
      <div className="modal-backdrop" onMouseDown={() => setSearchOpen(false)}>
        <section className="search-modal" onMouseDown={event => event.stopPropagation()} aria-label="搜索">
          <div className="search-modal-input">
            <Search size={18} aria-hidden="true" />
            <input
              autoFocus
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索会话"
              type="search"
              value={query}
            />
            <button aria-label="关闭搜索" onClick={() => setSearchOpen(false)} type="button">
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          {hasResults ? (
            <div className="search-results">
              {searchResults.sessions.length > 0 ? (
                <div className="search-result-group">
                  <span>会话</span>
                  {searchResults.sessions.map(session => (
                    <button
                      key={session.id}
                      onClick={() => {
                        openSession(session)
                        setSearchOpen(false)
                      }}
                      type="button"
                    >
                      <strong>{session.title}</strong>
                      <small>{shortId(session.id)}</small>
                    </button>
                  ))}
                </div>
              ) : null}

            </div>
          ) : (
            <div className="empty-compact">没有找到结果</div>
          )}
        </section>
      </div>
    )
  }

  function renderContextMenu() {
    if (!contextMenu) return null

    if (contextMenu.type === 'session') {
      const session = sessions.find(item => item.id === contextMenu.sessionId)
      if (!session) return null
      const removableProject = projectEntryForPath(session.project_path)
      const canRemoveProject =
        Boolean(removableProject) &&
        removableProject?.path !== activeProjectPathForRequest &&
        removableProject?.path !== workspace.path

      return (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={event => event.stopPropagation()}>
          <button onClick={() => {
            setContextMenu(null)
            openSession(session)
          }} type="button">
            <ChevronRight size={15} aria-hidden="true" />
            打开
          </button>
          <button onClick={() => {
            setContextMenu(null)
            void handleRenameSession(session)
          }} type="button">
            <Pencil size={15} aria-hidden="true" />
            重命名
          </button>
          <button onClick={() => {
            setContextMenu(null)
            void copyText(session.id, '会话 ID')
          }} type="button">
            <Copy size={15} aria-hidden="true" />
            复制 ID
          </button>
          <button onClick={() => {
            setContextMenu(null)
            void handleArchiveSession(session)
          }} type="button">
            <Archive size={15} aria-hidden="true" />
            归档对话
          </button>
          {removableProject ? (
            <button
              className="danger"
              disabled={!canRemoveProject}
              onClick={() => {
                setContextMenu(null)
                void handleRemoveProject(removableProject)
              }}
              title={canRemoveProject ? '移除项目' : '当前项目不能移除'}
              type="button"
            >
              <Trash2 size={15} aria-hidden="true" />
              移除项目
            </button>
          ) : null}
        </div>
      )
    }

    return null
  }

  function renderUpdateBanner() {
    if (!updateStatus.update_available) return null
    if (updateStatus.latest_revision && dismissedUpdateRevision === updateStatus.latest_revision) return null

    return (
      <section className="update-banner" aria-label="更新提示">
        <ArrowUp size={17} aria-hidden="true" />
        <div>
          <strong>检测到 Spark Code 更新</strong>
          <span>{updateStatus.detail}</span>
        </div>
        <button disabled={isCheckingUpdate} onClick={() => void checkForUpdates(true)} type="button">
          {isCheckingUpdate ? '检测中' : '重新检测'}
        </button>
        <button
          aria-label="忽略本次更新提示"
          onClick={() => setDismissedUpdateRevision(updateStatus.latest_revision ?? updateStatus.current_revision ?? 'dismissed')}
          type="button"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </section>
    )
  }

  function renderMainContent() {
    if (activeView === 'settings') return renderSettings()
    if (centerPanel === 'thinking') return renderThinking()
    if (centerPanel === 'editing') return renderEditing()
    return renderConversation()
  }

  function currentViewTitle() {
    if (activeView === 'chat') return activeSession.title
    return '设置'
  }

  if (!snapshotReady) {
    return (
      <main className="splash-screen" aria-label="Spark Code 正在启动">
        <section className="splash-panel">
          <div className="splash-logo-wrap">
            <img alt="Spark" src="/spark_logo.png" />
            <i aria-hidden="true" />
          </div>
          <div className="splash-copy">
            <strong>SPARK</strong>
            <h1>Spark Code</h1>
            <p>正在连接本地运行时</p>
          </div>
          <div className="splash-progress" aria-hidden="true">
            <span />
          </div>
        </section>
      </main>
    )
  }

  if (!sparkUser.logged_in) {
    return (
      <main className="auth-gate">
        <section className="auth-panel">
          <img alt="Spark" src="/spark_logo.png" />
          <strong>SPARK</strong>
          <h1>登录到 Spark Code</h1>
          <button className="primary-button" disabled={isStartingLogin} onClick={handleStartLogin} type="button">
            {isStartingLogin ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <KeyRound size={17} aria-hidden="true" />}
            使用 Spark Atlas 授权登录
          </button>
          {notice ? <p className="notice">{notice}</p> : null}
        </section>
      </main>
    )
  }

  const appShellClass = [
    'app-shell',
    activeView === 'settings' ? 'settings-mode' : '',
    reviewVisible ? 'review-open' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={appShellClass}>
      <aside className="left-sidebar">
        {activeView === 'settings' ? renderSettingsSidebar() : (
          <>
        <nav className="sidebar-primary-actions" aria-label="主入口">
          <button disabled={isCreatingSession} onClick={handleNewSession} type="button">
            <Pencil size={22} aria-hidden="true" />
            <span>新对话</span>
          </button>
          <button onClick={() => setSearchOpen(true)} type="button">
            <Search size={22} aria-hidden="true" />
            <span>搜索</span>
          </button>
          <button
            onClick={() => {
              setSettingsSection('tools')
              setActiveView('settings')
            }}
            type="button"
          >
            <Cpu size={22} aria-hidden="true" />
            <span>工具</span>
          </button>
        </nav>

        <div className={sessionListCollapsed ? 'session-list collapsed' : 'session-list'} aria-label="会话列表">
          <div className="session-group-title">
            <MessageSquareText size={14} aria-hidden="true" />
            <span>会话</span>
            <button
              aria-label={sessionListCollapsed ? '展开会话列表' : '收起会话列表'}
              onClick={() => setSessionListCollapsed(value => !value)}
              title={sessionListCollapsed ? '展开会话列表' : '收起会话列表'}
              type="button"
            >
              {sessionListCollapsed ? <PanelLeftOpen size={14} aria-hidden="true" /> : <PanelLeftClose size={14} aria-hidden="true" />}
            </button>
          </div>
          {sessionListCollapsed ? (
            <div className="collapsed-session-stack">
              <button
                className="collapsed-project-pill"
                onClick={() => setSessionListCollapsed(false)}
                title={activeProjectPathForRequest}
                type="button"
              >
                <FolderSymlink size={19} aria-hidden="true" />
                <span>{activeProjectName}</span>
              </button>
              <button
                className="collapsed-session-pill"
                onClick={() => openSession(activeSession)}
                onContextMenu={event => openSessionContextMenu(event, activeSession)}
                title={activeSession.title}
                type="button"
              >
                <span>{activeSession.title}</span>
              </button>
            </div>
          ) : (
            <div className="session-tree">
              {sessionProjectGroups.map(group => {
                const groupKey = sessionProjectKey(group.path, group.name)
                const collapsed = collapsedProjectPaths.has(groupKey)
                const removableProject = projectEntryForPath(group.path)
                return (
                  <section className={collapsed ? 'session-project-group collapsed' : 'session-project-group'} key={groupKey}>
                    <div className="session-project-row">
                      <button
                        className="session-project-node"
                        onClick={() => toggleProjectCollapsed(group.path, group.name)}
                        title={group.path || group.name}
                        type="button"
                      >
                        <span aria-hidden="true">|</span>
                        <strong>{group.name}</strong>
                        {collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                      </button>
                      {removableProject ? (
                        <button
                          aria-label={`移除项目 ${group.name}`}
                          className="session-project-remove"
                          onClick={event => {
                            event.stopPropagation()
                            void handleRemoveProject(removableProject)
                          }}
                          title="移除项目"
                          type="button"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                    {collapsed ? null : (
                      <div className="session-project-children">
                        {group.sessions.map(session => (
                          <button
                            className={session.id === activeSession.id ? 'session-child-item selected' : 'session-child-item'}
                            key={session.id}
                            onClick={() => openSession(session)}
                            onContextMenu={event => openSessionContextMenu(event, session)}
                            title={session.title}
                            type="button"
                          >
                            <span aria-hidden="true">|-</span>
                            <strong>{session.title}</strong>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </div>

        <div className="sidebar-bottom">
          {settingsMenuOpen ? (
            <section className="settings-popover" aria-label="设置菜单">
              <div className="settings-user-row">
                <div className={sparkUser.logged_in ? 'profile-avatar online compact' : 'profile-avatar compact'} aria-hidden="true">
                  {sparkUser.avatar_url ? (
                    <img alt="" src={sparkUser.avatar_url} />
                  ) : (
                    (sparkUser.email ?? sparkUser.name ?? 'S').slice(0, 1).toUpperCase()
                  )}
                </div>
                <div>
                  <strong>{sparkUserPrimary(sparkUser)}</strong>
                  <span>{sparkUserSecondary(sparkUser)}</span>
                </div>
              </div>
              <button className="sidebar-settings" onClick={() => {
                setActiveView('settings')
                setSettingsMenuOpen(false)
              }} type="button">
                <Settings2 size={17} aria-hidden="true" />
                主设置
              </button>
              <button className="sidebar-settings" disabled={isStartingLogin} onClick={handleStartLogin} type="button">
                {isStartingLogin ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <KeyRound size={17} aria-hidden="true" />}
                {sparkUser.logged_in ? '重新登录' : '登录 Spark'}
              </button>
              {sparkUser.logged_in ? (
                <button className="sidebar-settings danger" disabled={isLoggingOut} onClick={handleSparkLogout} type="button">
                  {isLoggingOut ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <X size={17} aria-hidden="true" />}
                  退出登录
                </button>
              ) : null}
            </section>
          ) : null}
          <button className="sidebar-settings" onClick={() => setSettingsMenuOpen(value => !value)} type="button">
            <Settings2 size={17} aria-hidden="true" />
            设置
          </button>
        </div>
          </>
        )}
      </aside>

      <main className="main-workspace">
        {activeView === 'chat' && !isNewConversation ? (
          <header className="top-bar">
            <div className="session-status">
              <h1>{currentViewTitle()}</h1>
              <button aria-label="更多" className="top-icon-button" type="button">•••</button>
            </div>
            <div className="top-actions">
              <button className={centerPanel === 'conversation' ? 'top-action active' : 'top-action'} onClick={() => setCenterPanel('conversation')} title="对话" type="button">
                <MessageSquareText size={16} aria-hidden="true" />
              </button>
              <button className={centerPanel === 'thinking' ? 'top-action active' : 'top-action'} onClick={() => setCenterPanel('thinking')} title="思考" type="button">
                <BrainCircuit size={16} aria-hidden="true" />
              </button>
              <button className={centerPanel === 'editing' ? 'top-action active' : 'top-action'} onClick={() => setCenterPanel('editing')} title="文件和操作" type="button">
                <FilePenLine size={16} aria-hidden="true" />
              </button>
              <button className={reviewOpen ? 'top-action active' : 'top-action'} onClick={() => setReviewOpen(value => !value)} title="审查" type="button">
                {reviewOpen ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRight size={16} aria-hidden="true" />}
              </button>
            </div>
          </header>
        ) : null}
        {renderUpdateBanner()}
        <section className={workspaceFrameClass}>
          <div
            className="workspace-body"
            ref={workspaceBodyRef}
            tabIndex={activeView === 'settings' ? 0 : -1}
          >
            {renderMainContent()}
          </div>

          {activeView === 'chat' && !isNewConversation ? renderComposer('dock') : null}
        </section>
      </main>

      {reviewVisible ? (
        <aside className="review-panel" aria-label="代码改动审核">
          <header className="review-header">
            <div>
              <span className="eyebrow">Review</span>
              <h2>{reviewTitle}</h2>
            </div>
            <button className="icon-button" onClick={() => setReviewOpen(false)} type="button" aria-label="关闭 Review">
              <PanelRightClose size={18} aria-hidden="true" />
            </button>
          </header>

          <section className="review-ide">
            <div className="review-file-list" aria-label="改动文件列表">
              <div className="review-summary">
                <div>
                  <Code2 size={18} aria-hidden="true" />
                  <span>待审核</span>
                  <strong>{activeChangeCount}</strong>
                </div>
                <div>
                  <History size={18} aria-hidden="true" />
                  <span>总记录</span>
                  <strong>{recentChanges.length}</strong>
                </div>
              </div>
              <div className="review-list">
                {recentChanges.length > 0 ? (
                  recentChanges.map(change => (
                    <button
                      className={[
                        'review-file-item',
                        change.id === selectedReviewChange?.id ? 'selected' : '',
                        change.status === 'reverted' ? 'reverted' : '',
                      ].filter(Boolean).join(' ')}
                      key={change.id}
                      onClick={() => void loadReviewDiff(change)}
                      type="button"
                    >
                      <span>{change.path}</span>
                      <strong>
                        <b className="added">+{change.added_lines ?? 0}</b>
                        <b className="removed">-{change.removed_lines ?? 0}</b>
                      </strong>
                    </button>
                  ))
                ) : (
                  <div className="empty-compact">暂无待审核代码改动</div>
                )}
              </div>
            </div>

            <div className="review-diff-viewer">
              {selectedReviewChange ? (
                <>
                  <header className="review-diff-toolbar">
                    <div>
                      <strong>{selectedReviewChange.path}</strong>
                      <span>{selectedReviewChange.summary} · {formatChangeTime(selectedReviewChange.timestamp)}</span>
                    </div>
                    <div>
                      <button
                        className="revert-button"
                        disabled={!selectedReviewChange.can_revert || selectedReviewChange.status === 'reverted' || revertingChangeId === selectedReviewChange.id}
                        onClick={() => handleRevertChange(selectedReviewChange.id)}
                        type="button"
                      >
                        {revertingChangeId === selectedReviewChange.id ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Undo2 size={15} aria-hidden="true" />}
                        撤销
                      </button>
                      <button
                        className="revert-button"
                        disabled={isSending}
                        onClick={() => {
                          const content = [
                            `请审核这个文件改动：${selectedReviewChange.path}`,
                            selectedReviewChange.summary,
                          ].join('\n')
                          if (isSending) {
                            enqueuePromptContent(content)
                          } else {
                            void submitPromptContent(content)
                          }
                        }}
                        type="button"
                      >
                        审查
                      </button>
                    </div>
                  </header>
                  <div className="review-diff-body" aria-busy={isLoadingReviewDiff}>
                    {isLoadingReviewDiff ? (
                      <div className="empty-compact">正在读取真实文件改动</div>
                    ) : reviewDiff?.error ? (
                      <div className="empty-compact">{reviewDiff.error}</div>
                    ) : reviewDiff?.rows.length ? (
                      visibleReviewDiffRows(reviewDiff.rows).map((row, index) => (
                        <div className={`review-diff-line ${row.type}`} key={`${row.type}-${row.oldLine ?? 'n'}-${row.newLine ?? 'n'}-${index}`}>
                          <span>{row.oldLine ?? ''}</span>
                          <span>{row.newLine ?? ''}</span>
                          <code>{row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '}{row.text}</code>
                        </div>
                      ))
                    ) : (
                      <div className="empty-compact">没有可显示的行级改动</div>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-compact">选择一个文件查看具体改动</div>
              )}
            </div>
          </section>
          {changeNotice ? <p className="notice">{changeNotice}</p> : null}
        </aside>
      ) : null}
      {renderSearchModal()}
      {renderContextMenu()}
    </div>
  )
}

export default App

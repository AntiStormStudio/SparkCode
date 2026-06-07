import { invoke } from '@tauri-apps/api/core'
import {
  Archive,
  Bot,
  BrainCircuit,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  FilePenLine,
  FileText,
  History,
  KeyRound,
  Loader2,
  MessageSquareText,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Pencil,
  Plug,
  Plus,
  Search,
  Send,
  ServerCog,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Undo2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react'
import type {
  AppPreferences,
  AppSnapshot,
  ChatMessage,
  McpServerEntry,
  ModelConfig,
  PermissionMode,
  ProjectEntry,
  RecentChange,
  RemoteDeviceBinding,
  Session,
  SparkUserProfile,
  SkillEntry,
  SlashCommandEntry,
} from './types'

type AppView = 'chat' | 'settings'
type CenterPanel = 'conversation' | 'thinking' | 'editing'
type QueuedPrompt = {
  id: string
  content: string
  sessionId: string
  sessionTitle: string
  createdAt: number
}
type ContextMenuState =
  | {
      type: 'session'
      x: number
      y: number
      sessionId: string
    }

const FIXED_BACKEND_URL = 'https://chat.spark-ai.top'

const fallbackSnapshot: AppSnapshot = {
  version: '0.2.0',
  remote: {
    backend_url: FIXED_BACKEND_URL,
    configured: true,
  },
  spark_user: {
    logged_in: false,
    id: null,
    name: null,
    email: null,
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
    selected: 'opus[1m]',
    options: [
      { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 4.6 · 适合日常编码任务' },
      { id: 'opus', name: 'Opus', description: 'Opus 4.6 · 适合复杂任务' },
      { id: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · 适合快速回答' },
      { id: 'sonnet[1m]', name: 'Sonnet（1M 上下文）', description: 'Sonnet 4.6 · 适合长会话' },
      { id: 'opus[1m]', name: 'Opus（1M 上下文）', description: 'Opus 4.6 · 适合大型代码库长会话' },
      { id: 'opusplan', name: 'Opus 计划模式', description: '计划用 Opus，执行用 Sonnet' },
      { id: 'best', name: 'Best', description: '自动选择当前最佳模型' },
    ],
  },
  workspace: {
    folder: 'Spark Code',
    path: '',
    mode: '编写模式',
    git_branch: null,
  },
  skills: [],
  mcp_servers: [],
  projects: [],
  recent_changes: [],
  slash_commands: [],
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
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}m` : `${rounded}m`
  }
  if (value >= 1_000) {
    const rounded = Math.round(value / 100) / 10
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}k` : `${rounded}k`
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

function compactValue(value: string | null | undefined): string {
  if (!value) return '未生成'
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}…${value.slice(-6)}`
}

function isAuthExpiredMessage(value: string): boolean {
  return /401|Invalid Android token|登录已过期|令牌无效|重新登录/i.test(value)
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

function formatChangeTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function parseSlashCommand(value: string): { name: string; args: string } | null {
  const match = value.trim().match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return {
    name: match[1].toLowerCase(),
    args: match[2]?.trim() ?? '',
  }
}

async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args)
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
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null)
  const creatingSessionRef = useRef(false)
  const [snapshot, setSnapshot] = useState<AppSnapshot>(fallbackSnapshot)
  const [activeSessionId, setActiveSessionId] = useState(fallbackSnapshot.sessions[0].id)
  const [activeView, setActiveView] = useState<AppView>('chat')
  const [centerPanel, setCenterPanel] = useState<CenterPanel>('conversation')
  const [activeProjectPath, setActiveProjectPath] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [sessionListCollapsed, setSessionListCollapsed] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({})
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([])
  const [prompt, setPrompt] = useState('')
  const [remoteBindCode, setRemoteBindCode] = useState('')
  const [activeSlashCommandIndex, setActiveSlashCommandIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [snapshotReady, setSnapshotReady] = useState(false)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isSavingModel, setIsSavingModel] = useState(false)
  const [isSavingPreferences, setIsSavingPreferences] = useState(false)
  const [isBindingRemoteDevice, setIsBindingRemoteDevice] = useState(false)
  const [isStartingLogin, setIsStartingLogin] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [revertingChangeId, setRevertingChangeId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [changeNotice, setChangeNotice] = useState<string | null>(null)

  async function refreshSnapshot() {
    try {
      const next = await safeInvoke<AppSnapshot>('get_app_snapshot')
      setSnapshot(next)
      setActiveProjectPath(current => {
        if (current && current !== fallbackSnapshot.workspace.path) return current
        return next.workspace.path
      })
      setActiveSessionId(current =>
        next.sessions.some(session => session.id === current)
          ? current
          : next.sessions[0]?.id ?? fallbackSnapshot.sessions[0].id,
      )
    } finally {
      setSnapshotReady(true)
    }
  }

  async function refreshSlashCommands(projectPath: string) {
    if (!projectPath.trim()) return
    const slashCommands = await safeInvoke<SlashCommandEntry[]>('get_slash_commands', {
      projectPath,
    })
    setSnapshot(current => ({ ...current, slash_commands: slashCommands }))
  }

  useEffect(() => {
    refreshSnapshot().catch(() => {})
  }, [])

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
    }
  }, [activeView])

  useEffect(() => {
    function closeFloatingUi() {
      setContextMenu(null)
      setPermissionMenuOpen(false)
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

  const sessions = snapshot.sessions
  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) ?? sessions[0] ?? fallbackSnapshot.sessions[0],
    [activeSessionId, sessions],
  )
  const messages = messagesBySession[activeSession.id] ?? []
  const visibleMessages = messages.filter(message => message.role !== 'system')
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
  const skills = snapshot.skills ?? []
  const mcpServers = snapshot.mcp_servers ?? []
  const slashCommands = snapshot.slash_commands ?? []
  const activeProjectPathForRequest = activeProjectPath || workspace.path
  const filteredSessions = sessions
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) {
      return {
        sessions: sessions.slice(0, 8),
        skills: skills.slice(0, 6),
        mcpServers: mcpServers.slice(0, 6),
      }
    }

    return {
      sessions: sessions
        .filter(session =>
          session.title.toLowerCase().includes(normalized) ||
          session.id.toLowerCase().includes(normalized),
        )
        .slice(0, 8),
      skills: skills
        .filter(skill =>
          skill.name.toLowerCase().includes(normalized) ||
          skill.path.toLowerCase().includes(normalized) ||
          (skill.description ?? '').toLowerCase().includes(normalized),
        )
        .slice(0, 6),
      mcpServers: mcpServers
        .filter(server =>
          server.name.toLowerCase().includes(normalized) ||
          (server.url ?? '').toLowerCase().includes(normalized) ||
          (server.command ?? '').toLowerCase().includes(normalized),
        )
        .slice(0, 6),
    }
  }, [mcpServers, query, sessions, skills])

  const activeChangeCount = recentChanges.filter(change => change.status !== 'reverted').length
  const reviewTitle = activeChangeCount > 0 ? `${activeChangeCount} 项改动` : '代码改动'
  const reviewVisible = activeView === 'chat' && reviewOpen
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
  const slashCommandPanelOpen = activeView === 'chat' && filteredSlashCommands.length > 0
  const isNewConversation =
    activeView === 'chat' && centerPanel === 'conversation' && visibleMessages.length === 0 && !isSending
  const workspaceFrameClass = [
    'workspace-frame',
    isNewConversation ? 'new-conversation-mode' : '',
    activeView !== 'chat' ? 'no-toolbar' : '',
  ].filter(Boolean).join(' ')

  useEffect(() => {
    setActiveSlashCommandIndex(0)
  }, [slashCommandQuery])

  function openChat() {
    setActiveView('chat')
    setCenterPanel('conversation')
    setSettingsMenuOpen(false)
  }

  function openSession(session: Session) {
    setActiveSessionId(session.id)
    if (session.project_path) {
      setActiveProjectPath(session.project_path)
    }
    openChat()
  }

  async function handleStartLogin() {
    setIsStartingLogin(true)
    setNotice(null)
    try {
      const user = await safeInvoke<string>('start_spark_login')
      setNotice(`已登录：${user}`)
      await refreshSnapshot()
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
      setNotice('已退出登录，请使用 /login 重新登录')
      await refreshSnapshot()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoggingOut(false)
    }
  }

  async function handleModelChange(model: string) {
    setIsSavingModel(true)
    setNotice(null)
    try {
      const next = await safeInvoke<ModelConfig>('save_model_config', { model })
      setSnapshot(current => ({ ...current, model: next }))
      setNotice(`模型名称已切换为 ${formatModelName(next)}`)
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
      setNotice('设置已保存')
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
      setNotice(device.bound ? 'Remote 设备已绑定' : device.status)
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
      setNotice('Remote 设备已解绑')
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
      setChangeNotice('已 Revert 更改')
    } catch (error) {
      setChangeNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setRevertingChangeId(null)
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
      setNotice('会话已重命名')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      await refreshSnapshot().catch(() => {})
    }
  }

  async function handleArchiveSession(session: Session) {
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
      setNotice('会话已归档')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      await refreshSnapshot().catch(() => {})
    }
  }

  async function copyText(value: string, label: string) {
    await navigator.clipboard?.writeText(value)
    setNotice(`${label} 已复制`)
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

  function addSystemMessage(content: string, sessionId = activeSession.id) {
    void sessionId
    setNotice(content)
  }

  function addLocalResultMessage(content: string, sessionId = activeSession.id) {
    setSessionMessages(sessionId, current => [
      ...current,
      {
        id: `local-${Date.now()}-${current.length}`,
        role: 'assistant',
        content,
      },
    ])
    setNotice(content)
  }

  async function runBackendLocalCommand(name: string, args: string) {
    setPrompt('')
    setNotice(null)
    try {
      const content = await safeInvoke<string>('run_local_command', { name, args })
      addLocalResultMessage(content)
    } catch (error) {
      addLocalResultMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function submitPromptContent(content: string, targetSession = activeSession) {
    const trimmed = content.trim()
    if (!trimmed || isSending) return
    const shouldResumeBackendSession = (messagesBySession[targetSession.id] ?? [])
      .some(message => message.role !== 'system')

    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    }
    setSessionMessages(targetSession.id, current => [...current, userMessage])
    setPrompt('')
    setIsSending(true)
    setNotice(null)

    try {
      const response = await safeInvoke<ChatMessage>('send_prompt', {
        prompt: trimmed,
        sessionId: targetSession.id,
        projectPath: targetSession.project_path || activeProjectPathForRequest,
        model: snapshot.model.selected,
        permissionMode: preferences.permission_mode,
        resume: shouldResumeBackendSession,
      })
      setSessionMessages(targetSession.id, current => [...current, response])
      setSnapshot(current => ({
        ...current,
        sessions: current.sessions.map(session =>
          session.id === targetSession.id
            ? {
                ...session,
                tokens: session.tokens + Math.ceil(trimmed.length / 2) + 480,
                context_used: Math.min(
                  session.context_limit,
                  session.context_used + Math.ceil(trimmed.length / 2) + 480,
                ),
              }
            : session,
        ),
      }))
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

  function enqueuePromptContent(content: string, targetSession = activeSession) {
    const trimmed = content.trim()
    if (!trimmed) return
    setQueuedPrompts(current => [
      ...current,
      {
        id: `q-${Date.now()}-${current.length}`,
        content: trimmed,
        sessionId: targetSession.id,
        sessionTitle: targetSession.title,
        createdAt: Date.now(),
      },
    ])
    setPrompt('')
    setNotice('已加入队列')
  }

  useEffect(() => {
    if (isSending || queuedPrompts.length === 0) return
    const [nextPrompt, ...rest] = queuedPrompts
    setQueuedPrompts(rest)
    const targetSession =
      sessions.find(session => session.id === nextPrompt.sessionId) ??
      activeSession
    void submitPromptContent(nextPrompt.content, targetSession)
  }, [activeSession, isSending, queuedPrompts, sessions])

  async function handleLocalSlashCommand(content: string): Promise<boolean> {
    const parsed = parseSlashCommand(content)
    if (!parsed) return false

    const openSettingsCommands = new Set([
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
      'model',
      'model-list',
      'model-reflex',
      'output-style',
      'permissions',
      'privacy-settings',
      'rate-limit-options',
      'remote',
      'remote-env',
      'sandbox',
      'statusline',
      'terminal-setup',
      'theme',
      'vim',
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
      setNotice(parsed.args ? `已压缩当前 GUI 对话。保留重点：${parsed.args}` : '已压缩当前 GUI 对话。')
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
        setSnapshot(current => {
          const projects = [
            project,
            ...current.projects.filter(item => item.path !== project.path),
          ]
          return {
            ...current,
            projects,
            workspace: {
              ...current.workspace,
              folder: project.name,
              path: project.path,
              git_branch: project.git_branch,
            },
          }
        })
        setActiveProjectPath(project.path)

        const existingSession = sessions.find(session => session.project_path === project.path)
        if (existingSession) {
          openSession(existingSession)
          addSystemMessage('已切换上下文')
          return true
        }

        const session = await safeInvoke<Session>('start_session', {
          title: '当前会话',
          projectPath: project.path,
        })
	        setSnapshot(current => ({ ...current, sessions: [session, ...current.sessions] }))
	        openSession(session)
	        setMessagesBySession(current => ({
	          ...current,
	          [session.id]: [],
	        }))
	        setNotice('已添加上下文')
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
	        setNotice(`已创建分支会话：${title}`)
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

    if (parsed.name === 'doctor') {
      addLocalResultMessage([
        'Spark Code GUI 诊断',
        `本地后端: 已启动`,
        `Remote: ${snapshot.remote.configured ? '已配置' : '未配置'}`,
        `Spark 用户: ${sparkUser.logged_in ? displayValue(sparkUser.name ?? sparkUser.email) : '未登录，请在设置中登录'}`,
        `模型: ${formatModelName(snapshot.model)}`,
        `Skills: ${skills.length}`,
        `MCP Servers: ${mcpServers.length}`,
      ].join('\n'))
      setPrompt('')
      return true
    }

    if (parsed.name === 'memory') {
      setPrompt('')
      try {
        const path = await safeInvoke<string>('open_memory_file')
        addLocalResultMessage(`已打开记忆文件：${path}`)
      } catch (error) {
        addLocalResultMessage(error instanceof Error ? error.message : String(error))
      }
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
      setPrompt('')
      return true
    }

    if (
      parsed.name === 'cost' ||
      parsed.name === 'release-notes' ||
      parsed.name === 'openterminal' ||
      parsed.name === 'open-terminal' ||
      parsed.name === 'stickers'
    ) {
      await runBackendLocalCommand(parsed.name, parsed.args)
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

    if (parsed.name === 'status') {
      addLocalResultMessage([
        `ID: ${shortId(activeSession.id)}`,
        `标题: ${activeSession.title}`,
        `模型: ${formatModelName(snapshot.model)}`,
        `Token: ${formatTokens(activeSession.tokens)} toks`,
        `上下文: ${formatTokens(activeSession.context_used)}/${formatTokens(activeSession.context_limit)}`,
        `Remote: ${snapshot.remote.configured ? 'Y' : 'N'}`,
      ].join('\n'))
      setPrompt('')
      return true
    }

    if (parsed.name === 'context') {
      const used = activeSession.context_used
      const limit = activeSession.context_limit
      const percent = limit > 0 ? Math.round((used / limit) * 100) : 0
      addLocalResultMessage([
        `上下文: ${formatTokens(used)}/${formatTokens(limit)}`,
        `占用: ${percent}%`,
        `Token: ${formatTokens(activeSession.tokens)} toks`,
        `模型: ${formatModelName(snapshot.model)}`,
      ].join('\n'))
      setPrompt('')
      return true
    }

    if (parsed.name === 'stats') {
      const totalTokens = sessions.reduce((sum, session) => sum + session.tokens, 0)
      addLocalResultMessage([
        `会话: ${sessions.length}`,
        `Token: ${formatTokens(totalTokens)} toks`,
        `近期更改: ${recentChanges.length}`,
        `Skills: ${skills.length}`,
        `MCP Servers: ${mcpServers.length}`,
      ].join('\n'))
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
      setPrompt('')
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

    if (openSettingsCommands.has(parsed.name)) {
      setActiveView('settings')
      setPrompt('')
      return true
    }

    return false
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!slashCommandPanelOpen) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveSlashCommandIndex(index => (index + 1) % filteredSlashCommands.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveSlashCommandIndex(index =>
        index === 0 ? filteredSlashCommands.length - 1 : index - 1,
      )
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const command = filteredSlashCommands[activeSlashCommandIndex]
      if (!command) return
      event.preventDefault()
      insertSlashCommand(command)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setPrompt('')
    }
  }

  async function handlePromptSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = prompt.trim()
    if (!content) return
    if (isSending) {
      enqueuePromptContent(content)
      return
    }
    if (await handleLocalSlashCommand(content)) return
    await submitPromptContent(content)
  }

  function handleAddContextClick() {
    if (prompt.trim()) {
      setNotice('请先发送或清空当前输入，再添加上下文')
      promptRef.current?.focus()
      return
    }
    setPrompt('/add-dir ')
    setNotice(null)
    setTimeout(() => promptRef.current?.focus(), 0)
  }

  function renderComposer(placement: 'center' | 'dock') {
    const centered = placement === 'center'
	
	    return (
	      <form className={centered ? 'composer composer-center' : 'composer'} onSubmit={handlePromptSubmit}>
	        <div className="composer-box">
	          <label className="sr-only" htmlFor="prompt">输入请求</label>
	          <textarea
	            id="prompt"
            onKeyDown={handlePromptKeyDown}
            onChange={event => setPrompt(event.target.value)}
	            placeholder="输入请求"
            ref={promptRef}
            rows={centered ? 4 : 3}
            value={prompt}
          />
          {slashCommandPanelOpen ? (
            <div className="slash-command-panel" role="listbox" aria-label="Slash commands">
              {filteredSlashCommands.map((command, index) => (
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
              ))}
            </div>
          ) : null}
	          <div className="composer-action-row">
	            <div className="composer-tools" aria-label="快捷工具">
	              <button aria-label="添加上下文" onClick={handleAddContextClick} title="添加上下文" type="button">
	                <Plus size={16} aria-hidden="true" />
	              </button>
              <div className="permission-control" onClick={event => event.stopPropagation()}>
                <button
                  className={permissionMenuOpen ? 'active' : ''}
                  onClick={() => setPermissionMenuOpen(value => !value)}
                  type="button"
                >
                  <ShieldCheck size={16} aria-hidden="true" />
                  {permissionLabel(preferences.permission_mode)}
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
              <label className="composer-model-select" htmlFor="composer-model-select">
                <Cpu size={16} aria-hidden="true" />
                <span className="sr-only">模型名称</span>
                <select
                  disabled={isSavingModel}
                  id="composer-model-select"
                  onChange={event => {
                    void handleModelChange(event.target.value)
                  }}
                  value={snapshot.model.selected}
                >
                  {snapshot.model.options.map(option => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="composer-submit-actions">
	              <button className="send-button" disabled={!prompt.trim()} type="submit">
                <Send size={17} aria-hidden="true" />
                <span>{isSending ? '加入队列' : '发送'}</span>
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
      </form>
    )
  }

  function renderQueuePanel() {
    if (queuedPrompts.length === 0) return null

    return (
      <section className="queue-panel" aria-label="待发送队列">
        <div className="queue-panel-header">
          <Archive size={16} aria-hidden="true" />
          <strong>队列</strong>
          <span>{queuedPrompts.length}</span>
        </div>
        <div className="queue-list">
          {queuedPrompts.map((item, index) => (
            <article className="queue-item" key={item.id}>
              <div className="queue-rank">{index + 1}</div>
              <div className="queue-content">
                <strong>{item.sessionTitle}</strong>
                <span>{shortId(item.sessionId)}</span>
                <p>{item.content}</p>
              </div>
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
    const conversationSignals = [
      { label: '任务', value: prompt.trim() ? '草稿已输入' : '等待输入', active: Boolean(prompt.trim()) },
      { label: '执行', value: isSending ? '处理中' : '空闲', active: isSending },
      { label: '改动', value: activeChangeCount > 0 ? `${activeChangeCount} 项待 Review` : '无待审核改动', active: activeChangeCount > 0 },
    ]

    return (
      <>
        <div className="conversation-stream" aria-live="polite">
          {renderQueuePanel()}

          {visibleMessages.length > 0 ? (
            <section className="conversation-insights" aria-label="对话状态">
              {conversationSignals.map(signal => (
                <div className={signal.active ? 'active' : ''} key={signal.label}>
                  <span>{signal.label}</span>
                  <strong>{signal.value}</strong>
                </div>
              ))}
            </section>
          ) : null}

          {recentChanges.length > 0 ? (
            <section className="conversation-activity" aria-label="正在编辑的文件">
              <div className="conversation-activity-header">
                <FilePenLine size={17} aria-hidden="true" />
                <strong>正在编辑</strong>
                <button className="text-button" onClick={() => setReviewOpen(true)} type="button">
                  Review
                </button>
              </div>
              <div className="conversation-activity-list">
                {recentChanges.slice(0, 3).map(change => (
                  <article className={change.status === 'reverted' ? 'activity-file reverted' : 'activity-file'} key={change.id}>
                    <FileText size={15} aria-hidden="true" />
                    <div>
                      <strong>{change.title}</strong>
                      <span>{change.path}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

	          {visibleMessages.length === 0 ? (
	            <section className="workspace-empty">
	              <h2>今天要做什么？</h2>
	              {renderComposer('center')}
	            </section>
	          ) : (
	            visibleMessages.map(message => (
	              <article className={`message-row ${message.role}`} key={message.id}>
	                <div className="message-icon" aria-hidden="true">
	                  {message.role === 'user' ? <TerminalSquare size={17} /> : <Bot size={17} />}
	                </div>
	                <div className="message-card">
	                  <span>{message.role === 'user' ? 'You' : 'Spark Code'}</span>
	                  <p>{message.content}</p>
	                </div>
	              </article>
            ))
          )}

          {isSending ? (
            <article className="message-row assistant">
              <div className="message-icon" aria-hidden="true">
                <Loader2 className="spin" size={17} />
              </div>
              <div className="message-card">
                <span>Spark Code</span>
                <p>处理中</p>
              </div>
            </article>
          ) : null}
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
      </section>
    )
  }

  function renderEditing() {
    return (
      <section className="editing-panel">
        <div className="process-header">
          <FilePenLine size={20} aria-hidden="true" />
          <div>
            <h2>正在编辑/操作</h2>
            <p>代码变更、文件操作和可回退记录会汇总到这里。</p>
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

  function renderSettings() {
    return (
      <section className="settings-workspace">
        <div className="settings-grid">
          <section className="settings-section profile-section">
            <div className="settings-heading">
              <ShieldCheck size={19} aria-hidden="true" />
              <div>
                <h3>Spark 用户</h3>
                <p>{sparkUser.logged_in ? '当前登录资料' : '未登录，请在设置中重新登录。'}</p>
              </div>
            </div>
            <div className="profile-card">
              <div className={sparkUser.logged_in ? 'profile-avatar online' : 'profile-avatar'} aria-hidden="true">
                {sparkUser.name?.slice(0, 1) ?? 'S'}
              </div>
              <div className="profile-main">
                <strong>{displayValue(sparkUser.name ?? sparkUser.email, '未登录')}</strong>
                <span>{sparkUser.logged_in ? displayValue(sparkUser.email) : '登录后会同步 Spark 用户资料'}</span>
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

          <section className="settings-section sync-section">
            <div className="settings-heading">
              <Sparkles size={19} aria-hidden="true" />
              <div>
                <h3>Skills</h3>
                <p>{skills.length} 个来自 ~/.codex 或 ~/.claude</p>
              </div>
            </div>
            {skills.length > 0 ? (
              <div className="directory-list compact">
                {skills.map(renderSkillItem)}
              </div>
            ) : (
              <div className="empty-compact">未找到可同步的 Skills</div>
            )}
          </section>

          <section className="settings-section sync-section">
            <div className="settings-heading">
              <Plug size={19} aria-hidden="true" />
              <div>
                <h3>MCP Servers</h3>
                <p>{mcpServers.length} 个来自 ~/.codex 或 ~/.claude</p>
              </div>
            </div>
            {mcpServers.length > 0 ? (
              <div className="directory-list compact">
                {mcpServers.map(renderMcpServer)}
              </div>
            ) : (
              <div className="empty-compact">未找到可同步的 MCP Servers</div>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-heading">
              <Cpu size={19} aria-hidden="true" />
              <div>
                <h3>模型名称</h3>
                <p>选择后立即保存，并用于后续会话。</p>
              </div>
            </div>
            <label className="settings-select-row" htmlFor="model-select">
              <span>模型名称</span>
              <select
                disabled={isSavingModel}
                id="model-select"
                onChange={event => handleModelChange(event.target.value)}
                value={snapshot.model.selected}
              >
                {snapshot.model.options.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.name} - {option.description}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="settings-section">
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

          <section className="settings-section">
            <div className="settings-heading">
              <ServerCog size={19} aria-hidden="true" />
              <div>
                <h3>Remote 设备绑定</h3>
                <p>绑定当前设备后，Remote 会使用本机身份接入。</p>
              </div>
            </div>
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

          <section className="settings-section">
            <div className="settings-heading">
              <Settings2 size={19} aria-hidden="true" />
              <div>
                <h3>主设置</h3>
                <p>这些配置会写入 Spark Code 本地配置。</p>
              </div>
            </div>
            <label className="settings-select-row" htmlFor="remote-startup-select">
              <span>Remote 自动启用</span>
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

  function sourceLabel(source: string) {
    if (source === 'codex') return '~/.codex'
    if (source === 'claude') return '~/.claude'
    return source
  }

  function renderSkillItem(skill: SkillEntry) {
    return (
      <article className="directory-item" key={skill.id}>
        <Sparkles size={17} aria-hidden="true" />
        <div>
          <strong>{skill.name}</strong>
          <span>{sourceLabel(skill.source)} · {skill.path}</span>
          {skill.description ? <p>{skill.description}</p> : null}
        </div>
      </article>
    )
  }

  function renderMcpServer(server: McpServerEntry) {
    const detail = server.url ?? server.command ?? '未配置启动命令'

    return (
      <article className="directory-item" key={server.id}>
        <Plug size={17} aria-hidden="true" />
        <div>
          <strong>{server.name}</strong>
          <span>{sourceLabel(server.source)} · {server.transport}</span>
          <p>{detail}</p>
        </div>
        <span className={server.enabled ? 'status-pill online' : 'status-pill'}>
          {server.enabled ? '启用' : '停用'}
        </span>
      </article>
    )
  }

  function renderSearchModal() {
    if (!searchOpen) return null

    const hasResults =
      searchResults.sessions.length > 0 ||
      searchResults.skills.length > 0 ||
      searchResults.mcpServers.length > 0

    return (
      <div className="modal-backdrop" onMouseDown={() => setSearchOpen(false)}>
        <section className="search-modal" onMouseDown={event => event.stopPropagation()} aria-label="搜索">
          <div className="search-modal-input">
            <Search size={18} aria-hidden="true" />
            <input
              autoFocus
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索会话、Skills、MCP"
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

              {searchResults.skills.length > 0 ? (
                <div className="search-result-group">
                  <span>Skills</span>
                  {searchResults.skills.map(skill => (
                    <button key={skill.id} onClick={() => {
                      setActiveView('settings')
                      setSearchOpen(false)
                    }} type="button">
                      <strong>{skill.name}</strong>
                      <small>{sourceLabel(skill.source)} · {skill.path}</small>
                    </button>
                  ))}
                </div>
              ) : null}

              {searchResults.mcpServers.length > 0 ? (
                <div className="search-result-group">
                  <span>MCP</span>
                  {searchResults.mcpServers.map(server => (
                    <button key={server.id} onClick={() => {
                      setActiveView('settings')
                      setSearchOpen(false)
                    }} type="button">
                      <strong>{server.name}</strong>
                      <small>{server.enabled ? '启用' : '停用'} · {server.transport}</small>
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
        </div>
      )
    }

    return null
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
      <main className="auth-gate">
        <section className="auth-panel">
          <img alt="Spark" src="/spark_logo.png" />
          <strong>SPARK</strong>
          <h1>正在连接 Spark Code</h1>
          <Loader2 className="spin" size={22} aria-hidden="true" />
        </section>
      </main>
    )
  }

  return (
    <div className={reviewVisible ? 'app-shell review-open' : 'app-shell'}>
      <aside className="left-sidebar">
        <button className="new-chat-button" disabled={isCreatingSession} onClick={handleNewSession} type="button">
          <Plus size={17} aria-hidden="true" />
          新对话
        </button>

        <button className="search-box search-trigger" onClick={() => setSearchOpen(true)} type="button">
          <Search size={16} aria-hidden="true" />
          <span>搜索</span>
        </button>

        <nav className="side-nav" aria-label="主导航">
          <button className={activeView === 'chat' ? 'active' : ''} onClick={openChat} type="button">
            <MessageSquareText size={17} aria-hidden="true" />
            会话
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
            <button
              className="session-item session-item-mini selected"
              onClick={() => openSession(activeSession)}
              onContextMenu={event => openSessionContextMenu(event, activeSession)}
              type="button"
            >
              <span className="session-main">
                <span className="session-title">{activeSession.title}</span>
                <span className="session-meta">{shortId(activeSession.id)}</span>
              </span>
            </button>
          ) : (
            filteredSessions.map(session => (
              <button
                className={session.id === activeSession.id ? 'session-item selected' : 'session-item'}
                key={session.id}
                onClick={() => openSession(session)}
                onContextMenu={event => openSessionContextMenu(event, session)}
                type="button"
              >
                <span className="session-main">
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    {shortId(session.id)} · {formatTokens(session.tokens)} toks
                  </span>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))
          )}
        </div>

        <div className="sidebar-bottom">
          {settingsMenuOpen ? (
            <section className="settings-popover" aria-label="设置菜单">
              <div className="settings-user-row">
                <div className={sparkUser.logged_in ? 'profile-avatar online compact' : 'profile-avatar compact'} aria-hidden="true">
                  {sparkUser.name?.slice(0, 1) ?? sparkUser.email?.slice(0, 1) ?? 'S'}
                </div>
                <div>
                  <strong>{displayValue(sparkUser.name ?? sparkUser.email, '未登录')}</strong>
                  <span>{sparkUser.logged_in ? 'Spark 用户' : '请先登录 Spark'}</span>
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
          <button className={activeView === 'settings' ? 'sidebar-settings active' : 'sidebar-settings'} onClick={() => setSettingsMenuOpen(value => !value)} type="button">
            <Settings2 size={17} aria-hidden="true" />
            设置
          </button>
        </div>
      </aside>

      <main className="main-workspace">
        {activeView === 'chat' && !isNewConversation ? (
          <header className="top-bar">
            <div className="session-status">
              <span>ID: <strong>{shortId(activeSession.id)}</strong></span>
              <span>T: <strong>{activeSession.title}</strong></span>
              <span>TK: <strong>{formatTokens(activeSession.tokens)}</strong> toks</span>
              <span>C: <strong>{formatTokens(activeSession.context_used)}/{formatTokens(activeSession.context_limit)}</strong></span>
              <span>R: <strong>{snapshot.remote.configured ? 'Y' : 'N'}</strong></span>
            </div>
            <div className="top-actions">
              <button className={reviewOpen ? 'top-action active' : 'top-action'} onClick={() => setReviewOpen(value => !value)} type="button">
                {reviewOpen ? <PanelRightClose size={16} aria-hidden="true" /> : <PanelRight size={16} aria-hidden="true" />}
                Review
              </button>
            </div>
          </header>
        ) : null}
        {activeView === 'chat' && notice ? <p className="global-notice">{notice}</p> : null}

        <section className={workspaceFrameClass}>
          {activeView === 'chat' && !isNewConversation ? (
            <div className="workspace-toolbar">
              <div>
                <span className="eyebrow">会话</span>
                <h1>{currentViewTitle()}</h1>
              </div>
            </div>
          ) : null}

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

          <section className="review-summary">
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
          </section>

          <section className="review-list">
            {recentChanges.length > 0 ? (
              recentChanges.map(change => (
                <article className={change.status === 'reverted' ? 'review-item reverted' : 'review-item'} key={change.id}>
                  <div>
                    <strong>{change.title}</strong>
                    <span>{change.path}</span>
                    <p>{change.summary}</p>
                    <small>{formatChangeTime(change.timestamp)}</small>
                  </div>
                  <button
                    className="revert-button"
                    disabled={!change.can_revert || change.status === 'reverted' || revertingChangeId === change.id}
                    onClick={() => handleRevertChange(change.id)}
                    type="button"
                  >
                    {revertingChangeId === change.id ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Undo2 size={15} aria-hidden="true" />}
                    {change.status === 'reverted' ? 'Reverted' : 'Revert'}
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-compact">暂无待审核代码改动</div>
            )}
            {changeNotice ? <p className="notice">{changeNotice}</p> : null}
          </section>
        </aside>
      ) : null}
      {renderSearchModal()}
      {renderContextMenu()}
    </div>
  )
}

export default App

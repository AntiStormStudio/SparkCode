export type Session = {
  id: string
  title: string
  tokens: number
  context_used: number
  context_limit: number
  project_path: string
  remote: boolean
}

export type RemoteConfig = {
  backend_url: string | null
  configured: boolean
}

export type SparkUserProfile = {
  logged_in: boolean
  id: string | null
  name: string | null
  email: string | null
  avatar_url: string | null
  organization_id: string | null
  organization_name: string | null
  billing_type: string | null
  account_created_at: string | null
}

export type RemoteDeviceBinding = {
  configured: boolean
  bound: boolean
  install_id: string | null
  device_id: string | null
  binding_id: string | null
  client_name: string | null
  package_name: string
  app_version: string
  status: string
}

export type AppPreferences = {
  permission_mode: PermissionMode
  remote_control_at_startup: boolean | null
  auto_compact_enabled: boolean
  show_turn_duration: boolean
  terminal_progress_bar_enabled: boolean
  file_checkpointing_enabled: boolean
  respect_gitignore: boolean
  copy_full_response: boolean
  auto_connect_ide: boolean
  auto_install_ide_extension: boolean
}

export type PermissionMode = 'limited' | 'auto-review' | 'full'

export type ModelOption = {
  id: string
  name: string
  description: string
}

export type ModelConfig = {
  selected: string
  options: ModelOption[]
}

export type WorkspaceInfo = {
  folder: string
  path: string
  mode: string
  git_branch: string | null
}

export type SkillEntry = {
  id: string
  name: string
  source: 'codex' | 'claude' | string
  path: string
  description: string | null
}

export type McpServerEntry = {
  id: string
  name: string
  source: 'codex' | 'claude' | string
  transport: string
  command: string | null
  url: string | null
  enabled: boolean
}

export type ToolEntry = {
  name: string
  description: string
  source: 'builtin' | 'mcp' | 'lsp' | string
  category: string
  read_only: boolean | null
  enabled: boolean
  mcp_server: string | null
  mcp_tool: string | null
  input_schema: unknown | null
  should_defer: boolean
}

export type ProjectEntry = {
  id: string
  name: string
  path: string
  git_branch: string | null
  trust_level: string | null
}

export type RecentChange = {
  id: string
  title: string
  path: string
  summary: string
  timestamp: string
  status: 'active' | 'reverted' | string
  can_revert: boolean
  before_content?: string | null
  added_lines?: number
  removed_lines?: number
}

export type SlashCommandEntry = {
  name: string
  description: string
  aliases: string[]
  category: string
  accepts_args: boolean
  type?: string | null
  source?: string | null
  loaded_from?: string | null
  argument_hint?: string | null
}

export type BackendRuntime = {
  local_url: string | null
  auth_token: string
  streaming_enabled: boolean
  context_limit: number
}

export type UpdateStatus = {
  current_version: string
  current_revision: string | null
  latest_revision: string | null
  checked_at: number
  update_available: boolean
  source: string
  detail: string
  release_url: string | null
  error: string | null
}

export type ProjectFileEntry = {
  path: string
  name: string
}

export type ProjectDirectoryEntry = {
  path: string
  name: string
  is_dir: boolean
  size: number
  modified_at: number | null
}

export type ProjectFileDocument = {
  path: string
  name: string
  content: string
  exists: boolean
  size: number
  modified_at: number | null
  recent_changes: RecentChange[]
}

export type MemoryDocument = {
  path: string
  content: string
  exists: boolean
}

export type ImageAttachment = {
  id: string
  name: string
  media_type: string
  data: string
}

export type AppSnapshot = {
  version: string
  remote: RemoteConfig
  spark_user: SparkUserProfile
  remote_device: RemoteDeviceBinding
  preferences: AppPreferences
  model: ModelConfig
  workspace: WorkspaceInfo
  skills: SkillEntry[]
  mcp_servers: McpServerEntry[]
  tools: ToolEntry[]
  projects: ProjectEntry[]
  recent_changes: RecentChange[]
  slash_commands: SlashCommandEntry[]
  backend_runtime: BackendRuntime
  update_status: UpdateStatus
  sessions: Session[]
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at?: number
  images?: ImageAttachment[]
}

export type RuntimeEvent = {
  id: string
  label: string
  value: string
  tone: 'success' | 'warning' | 'info' | 'muted'
  created_at?: number
}

export type GuiPermissionDecision = 'allow_once' | 'allow_session' | 'deny'

export type GuiPermissionRequest = {
  id: string
  session_id: string
  tool_use_id: string
  tool_name: string
  message: string
  description: string
  input: unknown
  suggestions: unknown[]
  blocked_path: string | null
  created_at: number
}

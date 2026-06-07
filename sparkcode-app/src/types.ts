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
}

export type SlashCommandEntry = {
  name: string
  description: string
  aliases: string[]
  category: string
  accepts_args: boolean
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
  projects: ProjectEntry[]
  recent_changes: RecentChange[]
  slash_commands: SlashCommandEntry[]
  sessions: Session[]
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type RuntimeEvent = {
  id: string
  label: string
  value: string
  tone: 'success' | 'warning' | 'info' | 'muted'
}

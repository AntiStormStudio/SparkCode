const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')

const PRODUCT_NAME = 'Spark Code'
const FIXED_BACKEND_URL = 'https://chat.spark-ai.top'
const LOCAL_BACKEND_AUTH_TOKEN = 'sparkcode-app-local'
const DEFAULT_CONTEXT_LIMIT = 256_000
const LARGE_CONTEXT_LIMIT = 1_000_000
const OAUTH_CALLBACK_HOST = '127.0.0.1'
const OAUTH_CALLBACK_PORT = 17654
const OAUTH_CALLBACK_PATH = '/spark/oauth/callback'
const SPARK_OAUTH_CLIENT_ID = 'spc_dHO3yMN-aKwgza37p2DNozfI47-SEXx9'
const SPARK_OAUTH_SCOPE = 'openid profile email'
const SPARK_OAUTH_CLIENT_SECRET_ENV_KEY = 'SPARK_OAUTH_CLIENT_SECRET'
const SPARK_AUTH_TOKEN_ENV_KEY = 'ANTHROPIC_AUTH_TOKEN'
const SPARK_REFRESH_TOKEN_ENV_KEY = 'SPARK_ANDROID_REFRESH_TOKEN'
const SPARK_BASE_URL_ENV_KEY = 'ANTHROPIC_BASE_URL'

let mainWindow = null
let backendProcess = null
let activeProjectPath = null
let sessions = []

function appIconPath() {
  if (process.platform === 'darwin') return path.resolve(__dirname, '..', 'src-tauri', 'icons', 'icon.icns')
  if (process.platform === 'win32') return path.resolve(__dirname, '..', 'src-tauri', 'icons', 'icon.ico')
  return path.resolve(__dirname, '..', 'src-tauri', 'icons', 'icon.png')
}

function appPngIconPath() {
  return path.resolve(__dirname, '..', 'src-tauri', 'icons', 'icon.png')
}

function homeDir() {
  return os.homedir()
}

function configDir() {
  return path.join(homeDir(), '.sparkc')
}

function cacheDir() {
  return path.join(configDir(), 'cache', 'sparkcode-app')
}

function sparkConfigPath() {
  return path.join(homeDir(), '.spark.json')
}

function localSettingsPath() {
  return path.join(configDir(), 'settings.json')
}

function appConfigPath(fileName) {
  return path.join(app.getPath('userData'), fileName)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function readSparkConfig() {
  return readJson(sparkConfigPath(), {})
}

function writeSparkConfig(value) {
  writeJson(sparkConfigPath(), value)
}

function envString(config, key) {
  const value = config?.env?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function valueString(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

function canonicalProjectPath(input) {
  const raw = String(input || '').trim()
  if (!raw) return workspacePath()
  try {
    return fs.realpathSync(raw)
  } catch {
    return path.resolve(raw)
  }
}

function workspacePath() {
  if (activeProjectPath) return activeProjectPath
  const fallback = path.join(cacheDir(), 'workspace')
  ensureDir(fallback)
  return fallback
}

function compactId(prefix) {
  return `${prefix}${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
}

function createSession(title, projectPath) {
  return {
    id: compactId('session-'),
    title: title || '当前会话',
    tokens: 0,
    context_used: 0,
    context_limit: loadPreferences().context_limit,
    project_path: canonicalProjectPath(projectPath || workspacePath()),
    remote: true,
  }
}

function ensureSessions() {
  if (sessions.length === 0) {
    sessions.push(createSession('当前会话', workspacePath()))
  }
  return sessions
}

function loadPreferences() {
  const config = readSparkConfig()
  const bool = (key, fallback) => typeof config[key] === 'boolean' ? config[key] : fallback
  const contextLimit = Number(config.contextLimit) === LARGE_CONTEXT_LIMIT ? LARGE_CONTEXT_LIMIT : DEFAULT_CONTEXT_LIMIT
  return {
    theme: valueString(config.theme) || 'system',
    editor_font_size: Number(config.editorFontSize) || 14,
    permission_mode: valueString(config.permissionMode) || 'default',
    sandbox_enabled: bool('sandboxEnabled', false),
    sandbox_auto_allow: bool('sandboxAutoAllow', true),
    remote_control_at_startup: typeof config.remoteControlAtStartup === 'boolean' ? config.remoteControlAtStartup : null,
    auto_compact_enabled: bool('autoCompactEnabled', true),
    context_limit: contextLimit,
    show_turn_duration: bool('showTurnDuration', true),
    terminal_progress_bar_enabled: bool('terminalProgressBarEnabled', true),
    file_checkpointing_enabled: bool('fileCheckpointingEnabled', true),
    respect_gitignore: bool('respectGitignore', true),
    copy_full_response: bool('copyFullResponse', false),
    auto_connect_ide: bool('autoConnectIde', true),
    auto_install_ide_extension: bool('autoInstallIdeExtension', false),
  }
}

function savePreferences(preferences) {
  const config = readSparkConfig()
  config.theme = preferences.theme
  config.editorFontSize = preferences.editor_font_size
  config.permissionMode = preferences.permission_mode
  config.sandboxEnabled = preferences.sandbox_enabled
  config.sandboxAutoAllow = preferences.sandbox_auto_allow
  config.remoteControlAtStartup = preferences.remote_control_at_startup
  config.autoCompactEnabled = preferences.auto_compact_enabled
  config.contextLimit = preferences.context_limit === LARGE_CONTEXT_LIMIT ? LARGE_CONTEXT_LIMIT : DEFAULT_CONTEXT_LIMIT
  config.showTurnDuration = preferences.show_turn_duration
  config.terminalProgressBarEnabled = preferences.terminal_progress_bar_enabled
  config.fileCheckpointingEnabled = preferences.file_checkpointing_enabled
  config.respectGitignore = preferences.respect_gitignore
  config.copyFullResponse = preferences.copy_full_response
  config.autoConnectIde = preferences.auto_connect_ide
  config.autoInstallIdeExtension = preferences.auto_install_ide_extension
  writeSparkConfig(config)
  return loadPreferences()
}

function backendRootCandidates() {
  const candidates = []
  if (process.env.SPARK_CODE_BUNDLED_BACKEND_ROOT) candidates.push(process.env.SPARK_CODE_BUNDLED_BACKEND_ROOT)
  candidates.push(path.resolve(__dirname, '..', '..'))
  candidates.push(path.resolve(process.resourcesPath || '', 'spark-code-backend'))
  candidates.push(path.join(cacheDir(), 'spark-code-backend'))
  return candidates.filter(Boolean)
}

function resourceBackendArchive() {
  const candidates = [
    path.resolve(__dirname, '..', 'src-tauri', 'resources', 'spark-code-backend.tar.gz'),
    path.resolve(process.resourcesPath || '', 'spark-code-backend.tar.gz'),
  ]
  return candidates.find(file => fs.existsSync(file)) || null
}

function ensureExtractedBackend() {
  const target = path.join(cacheDir(), 'spark-code-backend')
  if (fs.existsSync(path.join(target, 'src', 'server', 'server-entry.ts'))) return target
  const archive = resourceBackendArchive()
  if (!archive) return null
  ensureDir(cacheDir())
  fs.rmSync(target, { recursive: true, force: true })
  ensureDir(target)
  try {
    execFileSync('tar', ['-xzf', archive, '-C', target, '--strip-components', '1'], { stdio: 'ignore' })
    return fs.existsSync(path.join(target, 'src', 'server', 'server-entry.ts')) ? target : null
  } catch {
    fs.rmSync(target, { recursive: true, force: true })
    return null
  }
}

function findBackendRoot() {
  const extracted = ensureExtractedBackend()
  if (extracted) return extracted
  return backendRootCandidates().find(candidate =>
    fs.existsSync(path.join(candidate, 'src', 'server', 'server-entry.ts')) &&
    fs.existsSync(path.join(candidate, 'package.json')),
  ) || null
}

function findExecutable(name) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const paths = String(process.env.PATH || '').split(path.delimiter)
  for (const dir of paths) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return name
}

function bundledBun(root) {
  const name = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const candidates = [
    path.join(root, 'runtime', name),
    path.join(root, 'vendor', 'bun', name),
  ]
  return candidates.find(file => fs.existsSync(file)) || findExecutable('bun')
}

function serverLockPath() {
  return path.join(configDir(), `sparkcode-app-electron-${process.pid}.lock`)
}

function readLocalBackendUrl() {
  return valueString(readJson(serverLockPath(), {}).httpUrl)
}

async function waitForLocalBackendUrl() {
  for (let i = 0; i < 40; i += 1) {
    const url = readLocalBackendUrl()
    if (url?.startsWith('http://')) return url
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return null
}

function configureBackendEnv(env) {
  const config = readSparkConfig()
  const next = {
    ...env,
    SPARK_CODE_BACKEND_LAUNCHED_BY: 'sparkcode-app',
    SPARK_CODE_REMOTE_BACKEND_URL: FIXED_BACKEND_URL,
    XDG_CACHE_HOME: cacheDir(),
    BUN_INSTALL_CACHE_DIR: path.join(cacheDir(), 'bun-install'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(cacheDir(), 'bun-transpiler'),
    SPARK_CODE_SERVER_LOCK_PATH: serverLockPath(),
  }
  delete next.XPC_SERVICE_NAME
  delete next.XPC_FLAGS
  delete next.__CFBundleIdentifier
  delete next.ANTHROPIC_API_KEY
  delete next[SPARK_AUTH_TOKEN_ENV_KEY]
  delete next[SPARK_REFRESH_TOKEN_ENV_KEY]
  delete next[SPARK_BASE_URL_ENV_KEY]
  for (const key of [SPARK_AUTH_TOKEN_ENV_KEY, SPARK_REFRESH_TOKEN_ENV_KEY, SPARK_BASE_URL_ENV_KEY]) {
    const value = envString(config, key)
    if (value) next[key] = value
  }
  return next
}

function ensureLocalBackend() {
  ensureDir(configDir())
  ensureDir(cacheDir())
  if (backendProcess && !backendProcess.killed) {
    return backendRuntimeSnapshot()
  }
  const root = findBackendRoot()
  if (!root) throw new Error('无法找到 Spark Code 后端资源')
  const bun = bundledBun(root)
  const entry = path.join(root, 'src', 'server', 'server-entry.ts')
  const args = [
    '--no-orphans',
    'run',
    entry,
    'server',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--auth-token',
    LOCAL_BACKEND_AUTH_TOKEN,
    '--workspace',
    workspacePath(),
  ]
  backendProcess = spawn(bun, args, {
    cwd: root,
    env: configureBackendEnv(process.env),
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })
  backendProcess.once('exit', () => {
    backendProcess = null
  })
  return backendRuntimeSnapshot()
}

function stopLocalBackend() {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill()
  }
  backendProcess = null
  try {
    fs.rmSync(serverLockPath(), { force: true })
  } catch {
    // Ignore cleanup failures.
  }
}

function backendRuntimeSnapshot() {
  return {
    available: true,
    local_url: readLocalBackendUrl(),
    auth_token: LOCAL_BACKEND_AUTH_TOKEN,
    streaming_enabled: true,
    context_limit: loadPreferences().context_limit,
  }
}

async function postLocalBackendJson(route, body) {
  ensureLocalBackend()
  const base = await waitForLocalBackendUrl()
  if (!base) throw new Error('本地 Spark Code 后端尚未就绪')
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${LOCAL_BACKEND_AUTH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let value = {}
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`无法解析后端响应：${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    throw new Error(value.error || value.message || `本地后端请求失败：${response.status}`)
  }
  return value
}

async function curlJson(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let value = {}
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`无法解析后端响应：${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    const message = value?.error?.message || value?.message || value?.detail || text || response.statusText
    throw new Error(`${response.status}: ${message}`)
  }
  return value
}

async function ensureFreshSparkAuth() {
  const config = readSparkConfig()
  const refreshToken = envString(config, SPARK_REFRESH_TOKEN_ENV_KEY)
  if (!refreshToken) return loadSparkUserProfile()
  const refreshed = await exchangeOauthRefreshToken(refreshToken)
  const nextToken = refreshed.access_token || refreshed.accessToken
  const profile = nextToken ? await fetchProfile(nextToken).catch(() => null) : null
  saveSparkLogin(refreshed, profile)
  stopLocalBackend()
  return loadSparkUserProfile()
}

function loadSparkUserProfile() {
  const config = readSparkConfig()
  const account = config.oauthAccount || config.account || {}
  const token = envString(config, SPARK_AUTH_TOKEN_ENV_KEY)
  return {
    logged_in: Boolean(token),
    id: valueString(account.id) || valueString(account.user_id) || null,
    name: valueString(account.name) || valueString(account.username) || null,
    email: valueString(account.email) || null,
    avatar_url: valueString(account.avatar_url) || valueString(account.avatar) || null,
    organization_id: valueString(account.organization_id) || null,
    organization_name: valueString(account.organization_name) || null,
    billing_type: valueString(account.billing_type) || null,
    account_created_at: valueString(account.account_created_at) || null,
  }
}

function emptyCreditStatus(error = null) {
  return {
    available: 0,
    credit: 0,
    daily_limit: 0,
    daily_used: 0,
    daily_remaining: 0,
    daily_reset_at: null,
    emergency_remaining: 0,
    emergency_reset_at: null,
    subscription_name: null,
    subscription_expires_at: null,
    topup_url: `${FIXED_BACKEND_URL}/?settings=credit`,
    error,
  }
}

async function getCreditStatus() {
  const config = readSparkConfig()
  const token = envString(config, SPARK_AUTH_TOKEN_ENV_KEY)
  if (!token) return emptyCreditStatus('未登录')
  const fetchStatus = accessToken => curlJson(`${FIXED_BACKEND_URL}/api/v1/credit/status`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  try {
    const value = await fetchStatus(token).catch(async error => {
      const message = error instanceof Error ? error.message : String(error)
      if (!/401|unauthorized/i.test(message)) throw error
      const refreshToken = envString(config, SPARK_REFRESH_TOKEN_ENV_KEY)
      if (!refreshToken) throw error
      const refreshed = await exchangeOauthRefreshToken(refreshToken)
      const nextToken = refreshed.access_token || refreshed.accessToken
      if (!nextToken) throw error
      const profile = await fetchProfile(nextToken).catch(() => null)
      saveSparkLogin(refreshed, profile)
      return fetchStatus(nextToken)
    })
    const dailyLimit = Number(value.daily_limit || 0)
    const dailyUsed = Number(value.daily_used || 0)
    const dailyRemaining = Number(value.daily_remaining ?? Math.max(0, dailyLimit - dailyUsed))
    const credit = Number(value.credit || 0)
    return {
      available: Math.max(0, dailyRemaining + credit),
      credit,
      daily_limit: dailyLimit,
      daily_used: dailyUsed,
      daily_remaining: dailyRemaining,
      daily_reset_at: Number(value.daily_reset_at) || null,
      emergency_remaining: Number(value.emergency_remaining) || 0,
      emergency_reset_at: Number(value.emergency_reset_at) || null,
      subscription_name: value.subscription?.product_name || value.subscription?.name || null,
      subscription_expires_at: Number(value.subscription?.expires_at) || null,
      topup_url: `${FIXED_BACKEND_URL}/?settings=credit`,
      error: null,
    }
  } catch (error) {
    return emptyCreditStatus(error instanceof Error ? error.message : String(error))
  }
}

async function modelOptions() {
  const config = readSparkConfig()
  const token = envString(config, SPARK_AUTH_TOKEN_ENV_KEY)
  if (!token) return []
  const fetchModels = accessToken => curlJson(`${FIXED_BACKEND_URL}/api/v1/spark-code/oauth/models`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  try {
    const value = await fetchModels(token).catch(async error => {
      const message = error instanceof Error ? error.message : String(error)
      if (!/401|unauthorized/i.test(message)) throw error
      await ensureFreshSparkAuth()
      const nextToken = envString(readSparkConfig(), SPARK_AUTH_TOKEN_ENV_KEY)
      if (!nextToken) throw error
      return fetchModels(nextToken)
    })
    const raw = Array.isArray(value) ? value : Array.isArray(value.models) ? value.models : Array.isArray(value.data) ? value.data : []
    return raw.map((item) => {
      const id = typeof item === 'string' ? item : item.id || item.name || item.model
      return id ? {
        id,
        name: item.display_name || item.name || id,
        description: item.description || null,
      } : null
    }).filter(Boolean)
  } catch {
    return []
  }
}

async function modelConfig() {
  const options = await modelOptions()
  const config = readSparkConfig()
  const selected = valueString(config.model) || options[0]?.id || 'spark-code'
  return { selected, options }
}

function listProjects() {
  const config = readJson(appConfigPath('projects.json'), { projects: [] })
  const projects = Array.isArray(config.projects) ? config.projects : []
  const cwd = workspacePath()
  if (!projects.some(project => project.path === cwd)) {
    projects.unshift(projectEntry(cwd))
  }
  return projects
}

function projectEntry(projectPath) {
  const canonical = canonicalProjectPath(projectPath)
  return {
    id: canonical,
    name: path.basename(canonical) || canonical,
    path: canonical,
    git_branch: readGitBranch(canonical),
    trust_level: null,
  }
}

function readGitBranch(projectPath) {
  try {
    const head = fs.readFileSync(path.join(projectPath, '.git', 'HEAD'), 'utf8').trim()
    return head.startsWith('ref:') ? path.basename(head) : head.slice(0, 7)
  } catch {
    return null
  }
}

function saveProjects(projects) {
  writeJson(appConfigPath('projects.json'), { projects })
}

function workspaceInfo() {
  const current = workspacePath()
  return {
    folder: path.basename(current) || 'Spark Code',
    path: current,
    mode: 'remote',
  }
}

function loadSkills() {
  return []
}

function loadMcpServers() {
  return []
}

function toolCatalog(permissionMode = 'default') {
  return [
    { name: 'Read', description: '读取文件', source: 'builtin', enabled: true },
    { name: 'Edit', description: '修改文件', source: 'builtin', enabled: true },
    { name: 'Write', description: '写入文件', source: 'builtin', enabled: true },
    { name: 'Bash', description: '执行指令', source: 'builtin', enabled: true },
    { name: 'Grep', description: '搜索内容', source: 'builtin', enabled: true },
    { name: 'Glob', description: '匹配文件', source: 'builtin', enabled: true },
    { name: 'TodoWrite', description: '更新 Todo', source: 'builtin', enabled: true },
  ].map(tool => ({ ...tool, permission_mode: permissionMode }))
}

function slashCommands() {
  return [
    { name: 'compact', description: '压缩当前上下文', accepts_args: false },
    { name: 'resume', description: '继续某个会话', accepts_args: true },
    { name: 'copy', description: '复制回复', accepts_args: true },
    { name: 'rename', description: '重命名会话', accepts_args: true },
  ]
}

async function appSnapshot() {
  ensureLocalBackend()
  return {
    version: app.getVersion(),
    remote: { backend_url: FIXED_BACKEND_URL, configured: true },
    spark_user: loadSparkUserProfile(),
    credit_status: await getCreditStatus(),
    remote_device: {
      configured: false,
      bound: false,
      install_id: null,
      device_id: null,
      binding_id: null,
      client_name: null,
      package_name: 'top.spark-ai.sparkcode-app',
      app_version: app.getVersion(),
      status: '未绑定',
    },
    preferences: loadPreferences(),
    model: await modelConfig(),
    workspace: workspaceInfo(),
    skills: loadSkills(),
    mcp_servers: loadMcpServers(),
    tools: toolCatalog(loadPreferences().permission_mode),
    projects: listProjects(),
    recent_changes: [],
    slash_commands: slashCommands(),
    backend_runtime: backendRuntimeSnapshot(),
    update_status: updateStatus(),
    sessions: ensureSessions(),
  }
}

function updateStatus() {
  return {
    current_version: app.getVersion(),
    current_revision: null,
    latest_revision: null,
    checked_at: Date.now(),
    update_available: false,
    source: 'electron',
    detail: 'Electron build',
    release_url: null,
    error: null,
  }
}

function readProjectDirectory(projectPath, directoryPath = '') {
  const root = canonicalProjectPath(projectPath)
  const target = path.resolve(root, directoryPath || '.')
  if (!target.startsWith(root)) throw new Error('路径不在项目目录内')
  return fs.readdirSync(target, { withFileTypes: true }).map(entry => {
    const absolute = path.join(target, entry.name)
    const stat = fs.statSync(absolute)
    const relative = path.relative(root, absolute).replaceAll(path.sep, '/')
    return {
      name: entry.name,
      path: relative,
      kind: entry.isDirectory() ? 'directory' : 'file',
      size: entry.isFile() ? stat.size : null,
      modified_at: Math.floor(stat.mtimeMs),
    }
  }).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
}

function listProjectFiles(projectPath, query = '') {
  const root = canonicalProjectPath(projectPath)
  const normalizedQuery = String(query || '').toLowerCase()
  const out = []
  const walk = (dir) => {
    if (out.length >= 80) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'target') continue
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute).replaceAll(path.sep, '/')
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (!normalizedQuery || relative.toLowerCase().includes(normalizedQuery)) {
        out.push({ name: entry.name, path: relative, kind: 'file' })
      }
    }
  }
  walk(root)
  return out
}

function readProjectFile(projectPath, filePath) {
  const root = canonicalProjectPath(projectPath)
  const target = path.resolve(root, filePath)
  if (!target.startsWith(root)) throw new Error('路径不在项目目录内')
  const content = fs.readFileSync(target, 'utf8')
  return { path: path.relative(root, target).replaceAll(path.sep, '/'), content, exists: true }
}

function saveProjectFile(projectPath, filePath, content) {
  const root = canonicalProjectPath(projectPath)
  const target = path.resolve(root, filePath)
  if (!target.startsWith(root)) throw new Error('路径不在项目目录内')
  ensureDir(path.dirname(target))
  fs.writeFileSync(target, content)
  return readProjectFile(root, filePath)
}

function memoryPath() {
  return path.join(homeDir(), '.sparkc', 'SPARK.md')
}

function memoryDocument() {
  const file = memoryPath()
  return { path: file, content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', exists: fs.existsSync(file) }
}

async function startSparkLogin() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const state = `spark-oauth-${crypto.randomBytes(12).toString('hex')}`
  const redirectUri = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
  const code = await waitForOauthCode(state, redirectUri, challenge)
  const token = await exchangeOauthCode(code, verifier, redirectUri)
  const profile = await fetchProfile(token.access_token).catch(() => null)
  saveSparkLogin(token, profile)
  return '登录成功'
}

function waitForOauthCode(state, redirectUri, challenge) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirectUri)
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400)
        res.end('Invalid state')
        reject(new Error('OAuth state 不匹配'))
        server.close()
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        const error = url.searchParams.get('error') || 'OAuth 未返回 code'
        res.writeHead(400)
        res.end(error)
        reject(new Error(error))
        server.close()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<h1>登录成功</h1><p>可以回到 Spark Code。</p>')
      resolve(code)
      server.close()
    })
    server.once('error', reject)
    server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => {
      const authUrl = `${FIXED_BACKEND_URL}/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(SPARK_OAUTH_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SPARK_OAUTH_SCOPE)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`
      shell.openExternal(authUrl)
    })
  })
}

async function exchangeOauthCode(code, verifier, redirectUri) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: SPARK_OAUTH_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  const secret = process.env[SPARK_OAUTH_CLIENT_SECRET_ENV_KEY]
  if (secret) params.set('client_secret', secret)
  return curlJson(`${FIXED_BACKEND_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  })
}

async function exchangeOauthRefreshToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: SPARK_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  })
  const secret = process.env[SPARK_OAUTH_CLIENT_SECRET_ENV_KEY]
  if (secret) params.set('client_secret', secret)
  return curlJson(`${FIXED_BACKEND_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  })
}

async function fetchProfile(accessToken) {
  return curlJson(`${FIXED_BACKEND_URL}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
}

function saveSparkLogin(token, profile) {
  const config = readSparkConfig()
  config.env = config.env || {}
  const accessToken = token.access_token || token.accessToken
  if (accessToken) config.env[SPARK_AUTH_TOKEN_ENV_KEY] = accessToken
  if (token.refresh_token || token.refreshToken) config.env[SPARK_REFRESH_TOKEN_ENV_KEY] = token.refresh_token || token.refreshToken
  config.env[SPARK_BASE_URL_ENV_KEY] = FIXED_BACKEND_URL
  if (profile) config.oauthAccount = profile
  writeSparkConfig(config)
}

function logoutSpark() {
  const config = readSparkConfig()
  if (config.env) {
    delete config.env[SPARK_AUTH_TOKEN_ENV_KEY]
    delete config.env[SPARK_REFRESH_TOKEN_ENV_KEY]
  }
  delete config.oauthAccount
  writeSparkConfig(config)
  return loadSparkUserProfile()
}

async function invoke(command, args = {}) {
  switch (command) {
    case 'ensure_local_backend':
      return ensureLocalBackend()
    case 'get_app_snapshot':
      return appSnapshot()
    case 'get_credit_status':
      return getCreditStatus()
    case 'set_active_project_path':
      activeProjectPath = args.projectPath && args.projectPath !== '__sparkcode_no_project__' ? canonicalProjectPath(args.projectPath) : null
      return activeProjectPath
    case 'get_slash_commands':
      return slashCommands()
    case 'get_tool_catalog':
      return toolCatalog(args.permissionMode)
    case 'check_app_update':
      return updateStatus()
    case 'get_model_config':
      return modelConfig()
    case 'save_model_config': {
      const config = readSparkConfig()
      config.model = String(args.model || '').trim()
      writeSparkConfig(config)
      return modelConfig()
    }
    case 'save_preferences':
      return savePreferences(args.preferences)
    case 'read_memory_file':
      return memoryDocument()
    case 'save_memory_file':
      ensureDir(path.dirname(memoryPath()))
      fs.writeFileSync(memoryPath(), String(args.content || ''))
      return memoryDocument()
    case 'delete_memory_file':
      if (fs.existsSync(memoryPath())) fs.unlinkSync(memoryPath())
      return memoryDocument()
    case 'start_spark_login':
      return startSparkLogin()
    case 'logout_spark':
      return logoutSpark()
    case 'refresh_spark_auth': {
      return ensureFreshSparkAuth()
    }
    case 'pick_project_folder': {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], defaultPath: args.basePath || workspacePath() })
      return result.canceled ? null : result.filePaths[0]
    }
    case 'get_project_metadata':
      return projectEntry(args.projectPath)
    case 'add_project_path': {
      const project = projectEntry(args.path)
      const projects = [project, ...listProjects().filter(item => item.path !== project.path)]
      saveProjects(projects)
      activeProjectPath = project.path
      return project
    }
    case 'remove_project_path': {
      const removePath = canonicalProjectPath(args.projectPath)
      const projects = listProjects().filter(item => item.path !== removePath)
      saveProjects(projects)
      sessions = sessions.filter(session => session.project_path !== removePath)
      return projects
    }
    case 'start_session': {
      const session = createSession(args.title, args.projectPath)
      sessions.unshift(session)
      return session
    }
    case 'rename_session':
      sessions = sessions.map(session => session.id === args.sessionId ? { ...session, title: args.title } : session)
      return sessions
    case 'archive_session':
      sessions = sessions.filter(session => session.id !== args.sessionId)
      return sessions
    case 'list_project_files':
      return listProjectFiles(args.projectPath, args.query)
    case 'list_project_directory':
      return readProjectDirectory(args.projectPath, args.directoryPath)
    case 'read_project_file':
      return readProjectFile(args.projectPath, args.filePath)
    case 'save_project_file':
      return saveProjectFile(args.projectPath, args.filePath, args.content)
    case 'create_project_directory': {
      const root = canonicalProjectPath(args.projectPath)
      fs.mkdirSync(path.resolve(root, args.directoryPath), { recursive: true })
      return readProjectDirectory(root, path.dirname(args.directoryPath))
    }
    case 'rename_project_entry': {
      const root = canonicalProjectPath(args.projectPath)
      fs.renameSync(path.resolve(root, args.fromPath), path.resolve(root, args.toPath))
      return readProjectDirectory(root, path.dirname(args.toPath))
    }
    case 'delete_project_directory':
      fs.rmSync(path.resolve(canonicalProjectPath(args.projectPath), args.directoryPath), { recursive: true, force: true })
      return readProjectDirectory(args.projectPath, path.dirname(args.directoryPath))
    case 'delete_project_file':
      fs.rmSync(path.resolve(canonicalProjectPath(args.projectPath), args.filePath), { force: true })
      return []
    case 'revert_change':
      return []
    case 'read_clipboard_file_paths':
      return []
    case 'run_local_command':
      return String(execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/c', args.name] : ['-lc', `${args.name} ${args.args || ''}`], { cwd: args.projectPath || workspacePath(), encoding: 'utf8' }))
    case 'send_prompt': {
      ensureLocalBackend()
      const projectPath = canonicalProjectPath(args.projectPath)
      const body = {
        prompt: args.prompt,
        cwd: projectPath,
        session_id: args.sessionId,
        session_key: `sparkcode-app:${projectPath}:${args.sessionId}`,
        model: args.model,
        permission_mode: args.permissionMode,
        resume: args.resume,
        messages: args.messages || [],
        images: args.images || [],
      }
      const value = await postLocalBackendJson('/prompt', body).catch(async error => {
        const message = error instanceof Error ? error.message : String(error)
        if (!/未登录|401|unauthorized/i.test(message)) throw error
        await ensureFreshSparkAuth()
        ensureLocalBackend()
        return postLocalBackendJson('/prompt', body)
      })
      return { id: value.id || compactId('assistant-'), role: value.role || 'assistant', content: value.content || '已完成' }
    }
    case 'submit_feedback':
      return compactId('feedback-')
    case 'save_backend_base_url':
      return FIXED_BACKEND_URL
    case 'export_session_text':
      return ''
    case 'close_app':
      app.quit()
      return null
    default:
      throw new Error(`未实现 Electron 命令：${command}`)
  }
}

function createWindow() {
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(appPngIconPath())
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: PRODUCT_NAME,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.resolve(__dirname, '..', 'dist', 'index.html'))
  }
}

ipcMain.handle('sparkcode:invoke', async (_event, command, args) => invoke(command, args || {}))

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (backendProcess && !backendProcess.killed) backendProcess.kill()
})

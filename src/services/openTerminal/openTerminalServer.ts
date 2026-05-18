import { randomBytes } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'path'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8000
const CONFIG_FILE = 'open-terminal.json'
const MAX_CAPTURE_BYTES = 1024 * 1024

type PersistedOpenTerminalConfig = {
  apiKey?: string
  host?: string
  port?: number
  cwd?: string
}

export type OpenTerminalServerOptions = {
  host?: string
  port?: number
  cwd?: string
  rotateKey?: boolean
}

export type OpenTerminalServerInfo = {
  host: string
  port: number
  url: string
  openApiUrl: string
  apiKey: string
  cwd: string
}

type RunningProcess = {
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  startedAt: number
}

type ActiveOpenTerminalServer = {
  server: ReturnType<typeof Bun.serve>
  info: OpenTerminalServerInfo
  sessionCwds: Map<string, string>
  processes: Map<string, RunningProcess>
}

let activeServer: ActiveOpenTerminalServer | null = null

function configPath(): string {
  return resolve(getClaudeConfigHomeDir(), CONFIG_FILE)
}

async function loadConfig(): Promise<PersistedOpenTerminalConfig> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function saveConfig(config: PersistedOpenTerminalConfig): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
  await chmod(path, 0o600).catch(() => {})
}

function generateApiKey(): string {
  return `sk-spark-${randomBytes(24).toString('hex')}`
}

function buildInfo(config: Required<PersistedOpenTerminalConfig>): OpenTerminalServerInfo {
  const url = `http://${config.host}:${config.port}`
  return {
    host: config.host,
    port: config.port,
    url,
    openApiUrl: `${url}/openapi.json`,
    apiKey: config.apiKey,
    cwd: config.cwd,
  }
}

function corsHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, content-type, x-session-id, x-user-id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    ...extra,
  })
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
    }),
  })
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: corsHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
    }),
  })
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status)
}

function authorized(request: Request, apiKey: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  return header === `Bearer ${apiKey}`
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {}
  const value = await request.json().catch(() => ({}))
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function sessionIdFromRequest(request: Request): string {
  return request.headers.get('x-session-id') || 'default'
}

function getSessionCwd(state: ActiveOpenTerminalServer, request: Request): string {
  return state.sessionCwds.get(sessionIdFromRequest(request)) ?? state.info.cwd
}

function setSessionCwd(
  state: ActiveOpenTerminalServer,
  request: Request,
  cwd: string,
): void {
  state.sessionCwds.set(sessionIdFromRequest(request), cwd)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return path
}

function resolveTerminalPath(path: string | undefined, cwd: string): string {
  const value = expandHome((path || '.').trim() || '.')
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

async function resolveDirectory(path: string): Promise<string> {
  const resolved = resolveTerminalPath(path, getCwd())
  const info = await stat(resolved).catch(() => null)
  return info?.isDirectory() ? resolved : getCwd()
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk
  if (Buffer.byteLength(next) <= MAX_CAPTURE_BYTES) return next
  return next.slice(-MAX_CAPTURE_BYTES)
}

function tailOutput(value: string, tail: number): string {
  if (!tail || tail <= 0) return value
  const lines = value.split(/\r?\n/)
  return lines.length > tail ? lines.slice(-tail).join('\n') : value
}

function outputItems(stdout: string, stderr: string, tail: number) {
  const output: Array<{ type: 'stdout' | 'stderr'; data: string }> = []
  const stdoutTail = tailOutput(stdout, tail)
  const stderrTail = tailOutput(stderr, tail)
  if (stdoutTail) output.push({ type: 'stdout', data: stdoutTail })
  if (stderrTail) output.push({ type: 'stderr', data: stderrTail })
  return output
}

function processId(): string {
  return randomBytes(8).toString('hex')
}

async function runCommand(
  state: ActiveOpenTerminalServer,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request)
  const command = String(body.command ?? '').trim()
  if (!command) return errorResponse('command 不能为空', 400)

  const waitSeconds = Math.max(1, Math.min(Number(body.wait ?? 120) || 120, 3600))
  const tail = Math.max(0, Math.min(Number(body.tail ?? 2000) || 2000, 20000))
  const cwd = resolveTerminalPath(
    typeof body.cwd === 'string' ? body.cwd : undefined,
    getSessionCwd(state, request),
  )
  const cwdInfo = await stat(cwd).catch(() => null)
  if (!cwdInfo?.isDirectory()) return errorResponse(`目录不存在：${cwd}`, 400)
  setSessionCwd(state, request, cwd)

  const env =
    body.env && typeof body.env === 'object' && !Array.isArray(body.env)
      ? Object.fromEntries(
          Object.entries(body.env as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
      : {}

  const id = processId()
  const shell = process.env.SHELL || '/bin/sh'
  const child = spawn(shell, ['-lc', command], {
    cwd,
    env: {
      ...process.env,
      ...env,
      SPARKCODE: '1',
      OPEN_TERMINAL: '1',
    },
    windowsHide: true,
  })

  const running: RunningProcess = {
    child,
    stdout: '',
    stderr: '',
    startedAt: Date.now(),
  }
  state.processes.set(id, running)

  child.stdout.on('data', chunk => {
    running.stdout = appendBounded(running.stdout, String(chunk))
  })
  child.stderr.on('data', chunk => {
    running.stderr = appendBounded(running.stderr, String(chunk))
  })

  const done = new Promise<number | null>(resolveDone => {
    child.on('close', code => {
      state.processes.delete(id)
      resolveDone(code)
    })
    child.on('error', error => {
      running.stderr = appendBounded(running.stderr, errorMessage(error))
      state.processes.delete(id)
      resolveDone(1)
    })
  })

  const result = await Promise.race([
    done.then(code => ({ status: 'completed' as const, code })),
    new Promise<{ status: 'running'; code: null }>(resolveTimeout =>
      setTimeout(
        () => resolveTimeout({ status: 'running', code: null }),
        waitSeconds * 1000,
      ),
    ),
  ])

  return jsonResponse({
    id,
    status: result.status,
    exit_code: result.code,
    cwd,
    output: outputItems(running.stdout, running.stderr, tail),
  })
}

async function killProcess(
  state: ActiveOpenTerminalServer,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request)
  const id = String(body.process_id ?? body.id ?? '')
  const running = state.processes.get(id)
  if (!running) return jsonResponse({ ok: true, killed: false })
  running.child.kill(body.force === true ? 'SIGKILL' : 'SIGTERM')
  state.processes.delete(id)
  return jsonResponse({ ok: true, killed: true, id })
}

function guessContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.md':
    case '.txt':
    case '.log':
    case '.ts':
    case '.tsx':
    case '.py':
    case '.sh':
      return 'text/plain; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}

async function listFiles(cwd: string, directory: string): Promise<Response> {
  const dir = resolveTerminalPath(directory, cwd)
  const entries = await readdir(dir, { withFileTypes: true })
  const result = await Promise.all(
    entries.map(async entry => {
      const path = resolve(dir, entry.name)
      const info = await lstat(path)
      return {
        name: entry.name,
        path,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: info.size,
        modified: Math.floor(info.mtimeMs / 1000),
      }
    }),
  )
  return jsonResponse({ directory: dir, entries: result })
}

async function readTerminalFile(cwd: string, path: string): Promise<Response> {
  const resolved = resolveTerminalPath(path, cwd)
  const content = await readFile(resolved, 'utf8')
  return jsonResponse({
    path: resolved,
    total_lines: content ? content.split(/\r?\n/).length : 0,
    content,
  })
}

async function viewTerminalFile(cwd: string, path: string): Promise<Response> {
  const resolved = resolveTerminalPath(path, cwd)
  const data = await readFile(resolved)
  return new Response(data, {
    headers: corsHeaders({
      'Content-Type': guessContentType(resolved),
      'Content-Disposition': `inline; filename="${basename(resolved)}"`,
    }),
  })
}

async function writeTerminalFile(cwd: string, body: Record<string, unknown>) {
  const path = resolveTerminalPath(String(body.path ?? ''), cwd)
  const content = String(body.content ?? '')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  const info = await stat(path)
  return jsonResponse({ path, size: info.size })
}

async function replaceTerminalFileContent(
  cwd: string,
  body: Record<string, unknown>,
) {
  const path = resolveTerminalPath(String(body.path ?? ''), cwd)
  const oldContent = String(body.old_content ?? body.old ?? '')
  const newContent = String(body.new_content ?? body.new ?? '')
  const current = await readFile(path, 'utf8')
  if (!current.includes(oldContent)) {
    return errorResponse('未找到需要替换的内容', 400)
  }
  await writeFile(path, current.replace(oldContent, newContent), 'utf8')
  const info = await stat(path)
  return jsonResponse({ path, size: info.size })
}

async function uploadTerminalFile(
  cwd: string,
  request: Request,
  directory: string,
): Promise<Response> {
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return errorResponse('缺少上传文件', 400)
  const dir = resolveTerminalPath(directory || '.', cwd)
  await mkdir(dir, { recursive: true })
  const path = resolve(dir, file.name)
  await writeFile(path, Buffer.from(await file.arrayBuffer()))
  const info = await stat(path)
  return jsonResponse({ path, size: info.size })
}

async function deleteTerminalPath(cwd: string, path: string): Promise<Response> {
  const resolved = resolveTerminalPath(path, cwd)
  const info = await lstat(resolved)
  await rm(resolved, { recursive: info.isDirectory(), force: false })
  return jsonResponse({ path: resolved, type: info.isDirectory() ? 'directory' : 'file' })
}

async function handleRequest(
  state: ActiveOpenTerminalServer,
  request: Request,
): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  const url = new URL(request.url)
  const publicPath =
    url.pathname === '/health' ||
    url.pathname === '/openapi.json' ||
    url.pathname === '/api/config'
  if (!publicPath && !authorized(request, state.info.apiKey)) {
    return errorResponse('Unauthorized', 401)
  }

  try {
    const cwd = getSessionCwd(state, request)
    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, name: 'Spark Code OpenTerminal' })
    }
    if (url.pathname === '/api/config') {
      return jsonResponse({ features: { terminal: false, system: true } })
    }
    if (url.pathname === '/system') {
      return jsonResponse({
        prompt:
          '这是 Spark Code 提供的本地 OpenTerminal 运行环境。命令会在用户本机执行，请谨慎修改文件或运行有风险的命令。',
      })
    }
    if (url.pathname === '/openapi.json') {
      return jsonResponse(buildOpenApiSpec())
    }
    if (url.pathname === '/run_command' && request.method === 'POST') {
      return runCommand(state, request)
    }
    if (url.pathname === '/processes/kill' && request.method === 'POST') {
      return killProcess(state, request)
    }
    if (url.pathname === '/files/cwd' && request.method === 'GET') {
      return jsonResponse({ cwd })
    }
    if (url.pathname === '/files/cwd' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const nextCwd = resolveTerminalPath(String(body.path ?? ''), cwd)
      const info = await stat(nextCwd)
      if (!info.isDirectory()) return errorResponse('目标不是目录', 400)
      setSessionCwd(state, request, nextCwd)
      return jsonResponse({ cwd: nextCwd })
    }
    if (url.pathname === '/files/list' && request.method === 'GET') {
      return listFiles(cwd, url.searchParams.get('directory') ?? '.')
    }
    if (url.pathname === '/files/read' && request.method === 'GET') {
      return readTerminalFile(cwd, url.searchParams.get('path') ?? '')
    }
    if (url.pathname === '/files/view' && request.method === 'GET') {
      return viewTerminalFile(cwd, url.searchParams.get('path') ?? '')
    }
    if (url.pathname === '/files/write' && request.method === 'POST') {
      return writeTerminalFile(cwd, await readJsonBody(request))
    }
    if (url.pathname === '/files/replace' && request.method === 'POST') {
      return replaceTerminalFileContent(cwd, await readJsonBody(request))
    }
    if (url.pathname === '/files/mkdir' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const path = resolveTerminalPath(String(body.path ?? ''), cwd)
      await mkdir(path, { recursive: true })
      return jsonResponse({ path })
    }
    if (url.pathname === '/files/delete' && request.method === 'DELETE') {
      return deleteTerminalPath(cwd, url.searchParams.get('path') ?? '')
    }
    if (url.pathname === '/files/upload' && request.method === 'POST') {
      return uploadTerminalFile(cwd, request, url.searchParams.get('directory') ?? '.')
    }

    return errorResponse('Not Found', 404)
  } catch (error) {
    return errorResponse(errorMessage(error))
  }
}

function buildOpenApiSpec() {
  const pathParam = (name: string, description: string, required = true) => ({
    name,
    in: 'query',
    required,
    schema: { type: 'string', description },
  })

  return {
    openapi: '3.1.0',
    info: {
      title: 'Spark Code OpenTerminal',
      version: '1.0.0',
      description: 'Spark Code 本地 OpenTerminal 兼容服务',
    },
    paths: {
      '/run_command': {
        post: {
          operationId: 'run_command',
          summary: '执行 shell 命令',
          description: '在 Spark Code 所在电脑上执行 shell 命令。',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    command: { type: 'string', description: '要执行的 shell 命令' },
                    cwd: { type: 'string', description: '命令工作目录，可选' },
                    wait: {
                      type: 'integer',
                      description: '等待命令完成的秒数，默认 120',
                    },
                    tail: {
                      type: 'integer',
                      description: '返回输出的最大行数，默认 2000',
                    },
                    env: {
                      type: 'object',
                      description: '附加环境变量',
                      additionalProperties: { type: 'string' },
                    },
                  },
                  required: ['command'],
                },
              },
            },
          },
        },
      },
      '/files/list': {
        get: {
          operationId: 'list_files',
          summary: '列出文件',
          description: '列出目录内容。',
          parameters: [pathParam('directory', '要列出的目录，支持相对路径、绝对路径和 ~')],
        },
      },
      '/files/read': {
        get: {
          operationId: 'read_file',
          summary: '读取文件',
          description: '读取文本文件。',
          parameters: [pathParam('path', '文件路径')],
        },
      },
      '/files/view': {
        get: {
          operationId: 'display_file',
          summary: '查看或下载文件',
          description: '查看文件内容，二进制文件会按原始字节返回。',
          parameters: [pathParam('path', '文件路径')],
        },
      },
      '/files/write': {
        post: {
          operationId: 'write_file',
          summary: '写入文件',
          description: '写入 UTF-8 文本文件。',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: '文件路径' },
                    content: { type: 'string', description: '文件内容' },
                  },
                  required: ['path', 'content'],
                },
              },
            },
          },
        },
      },
      '/files/replace': {
        post: {
          operationId: 'replace_file_content',
          summary: '替换文件内容',
          description: '替换文本文件中的指定内容。',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: '文件路径' },
                    old_content: { type: 'string', description: '旧内容' },
                    new_content: { type: 'string', description: '新内容' },
                  },
                  required: ['path', 'old_content', 'new_content'],
                },
              },
            },
          },
        },
      },
      '/processes/kill': {
        post: {
          operationId: 'kill_process',
          summary: '终止进程',
          description: '终止仍在运行的命令。',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    process_id: { type: 'string', description: 'run_command 返回的进程 ID' },
                    force: { type: 'boolean', description: '是否强制终止' },
                  },
                  required: ['process_id'],
                },
              },
            },
          },
        },
      },
    },
  }
}

export async function startOpenTerminalServer(
  options: OpenTerminalServerOptions = {},
): Promise<OpenTerminalServerInfo> {
  if (activeServer) return activeServer.info

  const existing = await loadConfig()
  const requestedPort = options.port ?? existing.port ?? DEFAULT_PORT
  const host = options.host ?? existing.host ?? DEFAULT_HOST
  const cwd = await resolveDirectory(options.cwd ?? existing.cwd ?? getCwd())
  const apiKey =
    options.rotateKey || !existing.apiKey ? generateApiKey() : existing.apiKey

  let lastError: unknown
  for (let port = requestedPort; port < requestedPort + 20; port++) {
    const config: Required<PersistedOpenTerminalConfig> = {
      apiKey,
      host,
      port,
      cwd,
    }
    const info = buildInfo(config)
    const state: ActiveOpenTerminalServer = {
      server: undefined as unknown as ReturnType<typeof Bun.serve>,
      info,
      sessionCwds: new Map([['default', cwd]]),
      processes: new Map(),
    }
    try {
      state.server = Bun.serve({
        hostname: host,
        port,
        fetch: request => handleRequest(state, request),
      })
      activeServer = state
      await saveConfig(config)
      return info
    } catch (error) {
      lastError = error
    }
  }

  throw new Error(`OpenTerminal 启动失败：${errorMessage(lastError)}`)
}

export async function stopOpenTerminalServer(): Promise<boolean> {
  if (!activeServer) return false
  for (const running of activeServer.processes.values()) {
    running.child.kill('SIGTERM')
  }
  activeServer.server.stop(true)
  activeServer = null
  return true
}

export function getOpenTerminalServerInfo(): OpenTerminalServerInfo | null {
  return activeServer?.info ?? null
}

export async function getSavedOpenTerminalConfig(): Promise<PersistedOpenTerminalConfig> {
  return loadConfig()
}

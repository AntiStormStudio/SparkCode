import { hostname } from 'os'
import { basename } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { getBranch, getRemoteUrl, normalizeGitRemoteUrl } from '../../utils/git.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'

const STORAGE_KEY = 'sparkCodeRemote'

export type SparkCodeBinding = {
  id: string
  user_id: string
  name: string
  client_id?: string | null
  client_name?: string | null
  client_version?: string | null
  status: string
  data?: Record<string, unknown> | null
  meta?: Record<string, unknown> | null
  expires_at?: number | null
  last_seen_at?: number | null
  revoked_at?: number | null
  created_at: number
  updated_at: number
}

export type SparkCodeSession = {
  id: string
  user_id: string
  binding_id?: string | null
  title: string
  status: string
  cwd?: string | null
  branch?: string | null
  data?: Record<string, unknown> | null
  meta?: Record<string, unknown> | null
  created_at: number
  updated_at: number
}

export type SparkCodeEvent = {
  id: string
  session_id: string
  user_id: string
  binding_id?: string | null
  source: string
  type: string
  content?: string | null
  data?: Record<string, unknown> | null
  meta?: Record<string, unknown> | null
  created_at: number
}

export type SparkCodeRemoteCredentials = {
  endpoint: string
  clientToken: string
  bindingId: string
  userId: string
  clientId: string
  savedAt: number
}

type SparkCodeClientBindResponse = SparkCodeBinding & {
  client_token: string
  endpoint: string
  stream_endpoint?: string
}

export function normalizeSparkCodeEndpoint(rawValue: string): string {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    throw new Error('Remote 后端地址不能为空')
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new Error('Remote 后端地址格式无效，请填写类似 https://spark.example.com')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Remote 后端地址只支持 http 或 https')
  }

  if (parsed.search || parsed.hash) {
    throw new Error('Remote 后端地址不能包含查询参数或哈希')
  }

  const pathname = parsed.pathname.replace(/\/+$/g, '')
  if (!pathname || pathname === '/') {
    parsed.pathname = '/api/v1/spark-code'
  } else if (pathname === '/api/v1') {
    parsed.pathname = '/api/v1/spark-code'
  } else {
    parsed.pathname = pathname
  }

  return parsed.toString().replace(/\/$/g, '')
}

export async function getSparkCodeStatus(endpoint: string): Promise<{
  status: boolean
  name: string
  protocol_version: string
  pairing_ttl: number
  event_types: string[]
}> {
  return sparkCodeFetch(endpoint, '/status')
}

export async function bindSparkCodeClient(
  endpoint: string,
  code: string,
): Promise<SparkCodeRemoteCredentials> {
  const clientId = `spark-code-cli-${hostname() || 'local'}`
  const response = await sparkCodeFetch<SparkCodeClientBindResponse>(
    endpoint,
    '/client/bind',
    {
      method: 'POST',
      body: {
        code,
        client_id: clientId,
        client_name: `Spark Code CLI on ${hostname() || process.platform}`,
        client_version: MACRO.VERSION,
        data: {
          platform: process.platform,
          runtime: 'spark-code-cli',
        },
        meta: {
          cwd: getCwd(),
        },
      },
    },
  )

  const credentials: SparkCodeRemoteCredentials = {
    endpoint: normalizeSparkCodeEndpoint(response.endpoint || endpoint),
    clientToken: response.client_token,
    bindingId: response.id,
    userId: response.user_id,
    clientId,
    savedAt: Math.floor(Date.now() / 1000),
  }
  saveSparkCodeCredentials(credentials)
  return credentials
}

export async function getSparkCodeClientMe(
  credentials: SparkCodeRemoteCredentials,
): Promise<SparkCodeBinding> {
  return sparkCodeFetch(credentials.endpoint, '/client/me', {
    token: credentials.clientToken,
  })
}

export async function upsertSparkCodeCurrentSession(
  credentials: SparkCodeRemoteCredentials,
  title?: string,
): Promise<SparkCodeSession> {
  const cwd = getCwd()
  const [branch, remoteUrl] = await Promise.all([
    getBranch().catch(() => null),
    getRemoteUrl().catch(() => null),
  ])
  const repo = remoteUrl ? normalizeGitRemoteUrl(remoteUrl) : null

  return sparkCodeFetch(credentials.endpoint, '/client/sessions', {
    method: 'POST',
    token: credentials.clientToken,
    body: {
      id: getSessionId(),
      title: title?.trim() || basename(cwd) || 'Spark Code Session',
      cwd,
      branch,
      status: 'active',
      data: {
        runtime: 'spark-code-cli',
        ...(repo ? { repo } : {}),
      },
      meta: {
        started_by: 'cli',
        version: MACRO.VERSION,
      },
    },
  })
}

export async function createSparkCodeEvent(
  credentials: SparkCodeRemoteCredentials,
  sessionId: string,
  event: {
    type: string
    source?: string
    content?: string
    data?: Record<string, unknown>
    meta?: Record<string, unknown>
  },
): Promise<SparkCodeEvent> {
  return sparkCodeFetch(
    credentials.endpoint,
    `/client/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      method: 'POST',
      token: credentials.clientToken,
      body: event,
    },
  )
}

export function getSparkCodeCredentials():
  | SparkCodeRemoteCredentials
  | undefined {
  const data = getSecureStorage().read()
  const value = data?.[STORAGE_KEY]
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const credentials = value as Partial<SparkCodeRemoteCredentials>
  if (
    !credentials.endpoint ||
    !credentials.clientToken ||
    !credentials.bindingId ||
    !credentials.userId ||
    !credentials.clientId
  ) {
    return undefined
  }
  return credentials as SparkCodeRemoteCredentials
}

export function saveSparkCodeCredentials(
  credentials: SparkCodeRemoteCredentials,
): void {
  const storage = getSecureStorage()
  const data = storage.read() || {}
  const result = storage.update({
    ...data,
    [STORAGE_KEY]: credentials,
  })
  if (!result.success) {
    throw new Error('Remote client_token 保存失败')
  }
}

export function clearSparkCodeCredentials(): void {
  const storage = getSecureStorage()
  const data = storage.read()
  if (!data || !(STORAGE_KEY in data)) {
    return
  }
  const { [STORAGE_KEY]: _removed, ...rest } = data
  const result = storage.update(rest)
  if (!result.success) {
    throw new Error('Remote client_token 清除失败')
  }
}

async function sparkCodeFetch<T>(
  endpoint: string,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH'
    token?: string
    body?: Record<string, unknown>
  } = {},
): Promise<T> {
  const normalizedEndpoint = normalizeSparkCodeEndpoint(endpoint)
  const response = await fetch(`${normalizedEndpoint}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object'
        ? ((payload as { detail?: unknown; message?: unknown }).detail ??
          (payload as { message?: unknown }).message)
        : null
    throw new Error(
      typeof message === 'string'
        ? message
        : `Remote 请求失败：HTTP ${response.status}`,
    )
  }

  if (payload === null) {
    throw new Error('Remote 响应为空')
  }

  return payload as T
}

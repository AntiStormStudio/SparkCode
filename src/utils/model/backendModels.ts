import axios from 'axios'
import {
  clearConfiguredAndroidAuth,
  getConfiguredApiBaseUrl,
  getConfiguredAuthToken,
  normalizeApiBaseUrl,
} from '../auth.js'
import { getUserAgent } from '../http.js'
import { refreshConfiguredAndroidToken } from '../sparkAndroidAuth.js'

const MODEL_LIST_PATH = '/api/v1/android/models'

export type BackendModelEntry = {
  id: string
  name?: string
  description?: string
}

export type BackendModelList = {
  baseUrl: string
  items: BackendModelEntry[]
  total: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function describeHttpError(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : '请求失败'
  }

  const status = error.response?.status
  const data = error.response?.data
  let detail = ''

  if (typeof data === 'string') {
    detail = data
  } else if (isRecord(data)) {
    detail =
      getString(data.detail) ??
      getString(data.message) ??
      getString(data.error) ??
      ''
  }

  if (status === 401) {
    return '登录已过期或令牌无效，请重新运行 /login'
  }
  if (status === 403) {
    return detail ? `没有权限：${detail}` : '没有权限访问模型列表'
  }
  if (status) {
    return `后端返回 ${status}${detail ? `：${detail}` : ''}`
  }

  return error.message
}

function backendModelRequestTimeoutMs(): number {
  return process.env.SPARK_CODE_BACKEND_LAUNCHED_BY === 'sparkcode-app'
    ? 2_500
    : 15_000
}

function parseModelEntry(value: unknown): BackendModelEntry | null {
  if (!isRecord(value)) return null

  const id =
    getString(value.id) ?? getString(value.model) ?? getString(value.value)
  if (!id) return null

  const name =
    getString(value.name) ??
    getString(value.label) ??
    getString(value.title) ??
    undefined
  const description =
    getString(value.description) ??
    getString(value.detail) ??
    getString(value.summary) ??
    undefined

  return { id, name, description }
}

function parseModelList(data: unknown): {
  items: BackendModelEntry[]
  total: number | null
} {
  if (Array.isArray(data)) {
    return {
      items: data
        .map(parseModelEntry)
        .filter((item): item is BackendModelEntry => !!item),
      total: data.length,
    }
  }

  if (!isRecord(data)) {
    return { items: [], total: null }
  }

  const rawItems =
    Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.data)
        ? data.data
        : Array.isArray(data.models)
          ? data.models
          : null

  if (rawItems) {
    return {
      items: rawItems
        .map(parseModelEntry)
        .filter((item): item is BackendModelEntry => !!item),
      total: getNumber(data.total) ?? rawItems.length,
    }
  }

  const single = parseModelEntry(data)
  return single
    ? { items: [single], total: 1 }
    : { items: [], total: getNumber(data.total) }
}

export function formatBackendModelList({
  baseUrl,
  items,
  total,
}: BackendModelList): string {
  if (items.length === 0) {
    return `后端 ${baseUrl} 没有返回可用模型。`
  }

  const title =
    total !== null ? `模型列表（${total} 个）` : `模型列表（${items.length} 个）`
  const lines = items.map((item, index) => {
    const label = item.name ? `${item.id} · ${item.name}` : item.id
    return item.description
      ? `${index + 1}. ${label} - ${item.description}`
      : `${index + 1}. ${label}`
  })

  return [title, `后端：${baseUrl}`, '', ...lines].join('\n')
}

export async function fetchBackendModelList(): Promise<BackendModelList> {
  const configuredBaseUrl = getConfiguredApiBaseUrl()
  if (!configuredBaseUrl) {
    throw new Error('请先运行 /config-server <后端地址>')
  }

  const baseUrl = normalizeApiBaseUrl(configuredBaseUrl)
  const requestTimeoutMs = backendModelRequestTimeoutMs()
  let authToken = getConfiguredAuthToken()
  if (!authToken) {
    authToken = await refreshConfiguredAndroidToken(baseUrl, requestTimeoutMs)
  }
  if (!authToken) {
    throw new Error('请先运行 /login 获取后端登录令牌')
  }

  const requestModelList = (token: string) =>
    axios.get(`${baseUrl}${MODEL_LIST_PATH}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': getUserAgent(),
      },
      timeout: requestTimeoutMs,
    })

  let response: Awaited<ReturnType<typeof requestModelList>> | null = null
  try {
    response = await requestModelList(authToken)
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      const nextAuthToken = await refreshConfiguredAndroidToken(baseUrl, requestTimeoutMs)
      if (nextAuthToken) {
        try {
          response = await requestModelList(nextAuthToken)
        } catch (retryError) {
          if (axios.isAxiosError(retryError) && retryError.response?.status === 401) {
            clearConfiguredAndroidAuth()
          }
          throw new Error(describeHttpError(retryError))
        }
      } else {
        clearConfiguredAndroidAuth()
        throw new Error(describeHttpError(error))
      }
    } else {
      throw new Error(describeHttpError(error))
    }
  }

  if (!response) {
    throw new Error('模型列表获取失败')
  }

  const parsed = parseModelList(response.data)
  return {
    baseUrl,
    items: parsed.items,
    total: parsed.total,
  }
}

export function findBackendModelMatch(
  items: BackendModelEntry[],
  input: string,
): BackendModelEntry | null {
  const normalized = input.trim()
  if (!normalized) return null

  const exact = items.find(
    item => item.id === normalized || item.name === normalized,
  )
  if (exact) return exact

  const lower = normalized.toLowerCase()
  return (
    items.find(
      item =>
        item.id.toLowerCase() === lower || item.name?.toLowerCase() === lower,
    ) ?? null
  )
}

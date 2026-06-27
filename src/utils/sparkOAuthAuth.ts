import {
  clearConfiguredAndroidAuth,
  getConfiguredAuthRefreshToken,
  saveConfiguredAuthRefreshToken,
  saveConfiguredAuthToken,
} from './auth.js'
import { getUserAgent } from './http.js'

const OAUTH_TOKEN_PATH = '/oauth2/token'
const SPARK_OAUTH_CLIENT_ID = 'spc_dHO3yMN-aKwgza37p2DNozfI47-SEXx9'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function refreshConfiguredSparkOAuthToken(
  baseUrl: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  const refreshToken = getConfiguredAuthRefreshToken()
  if (!refreshToken) return null

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), timeoutMs)
  let response: Response
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: SPARK_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    })
    response = await fetch(`${baseUrl}${OAUTH_TOKEN_PATH}`, {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getUserAgent(),
      },
      body,
    })
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearConfiguredAndroidAuth()
    }
    return null
  }

  const data = await response.json()
  if (!isRecord(data)) return null

  const accessToken = getString(data.access_token) ?? getString(data.accessToken)
  if (!accessToken) return null

  saveConfiguredAuthToken(accessToken)
  const nextRefreshToken = getString(data.refresh_token) ?? getString(data.refreshToken)
  if (nextRefreshToken) {
    saveConfiguredAuthRefreshToken(nextRefreshToken)
  }
  return accessToken
}

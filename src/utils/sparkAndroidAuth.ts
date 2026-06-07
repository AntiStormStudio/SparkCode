import { randomUUID } from 'crypto'
import {
  clearConfiguredAndroidAuth,
  getConfiguredAuthRefreshToken,
  saveConfiguredAuthRefreshToken,
  saveConfiguredAuthToken,
} from './auth.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getUserAgent } from './http.js'

const ANDROID_AUTH_REFRESH_PATH = '/api/v1/android/auth/refresh'
const SPARK_PACKAGE_NAME = 'com.sparkatlas.app'
const SPARK_APP_VERSION = '9.0.3'
const SPARK_CERT_SHA256 =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SPARK_INSTALL_ID_ENV_KEY = 'SPARK_ANDROID_INSTALL_ID'
const SPARK_DEVICE_ID_ENV_KEY = 'SPARK_ANDROID_DEVICE_ID'

export type SparkAndroidDevice = {
  installId: string
  deviceId: string
  packageName: string
  certSha256: string
  appVersion: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function getOrCreateSparkAndroidDevice(): SparkAndroidDevice {
  const env = getGlobalConfig().env ?? {}
  const installId =
    getString(env[SPARK_INSTALL_ID_ENV_KEY]) ?? `spark-code-${randomUUID()}`
  const deviceId =
    getString(env[SPARK_DEVICE_ID_ENV_KEY]) ?? `spark-code-${randomUUID()}`

  if (
    env[SPARK_INSTALL_ID_ENV_KEY] !== installId ||
    env[SPARK_DEVICE_ID_ENV_KEY] !== deviceId
  ) {
    saveGlobalConfig(current => ({
      ...current,
      env: {
        ...(current.env ?? {}),
        [SPARK_INSTALL_ID_ENV_KEY]: installId,
        [SPARK_DEVICE_ID_ENV_KEY]: deviceId,
      },
    }))
  }

  return {
    installId,
    deviceId,
    packageName: SPARK_PACKAGE_NAME,
    certSha256: SPARK_CERT_SHA256,
    appVersion: SPARK_APP_VERSION,
  }
}

export function getStoredSparkAndroidDevice(): SparkAndroidDevice | null {
  const env = getGlobalConfig().env ?? {}
  const installId = getString(env[SPARK_INSTALL_ID_ENV_KEY])
  const deviceId = getString(env[SPARK_DEVICE_ID_ENV_KEY])
  if (!installId || !deviceId) return null

  return {
    installId,
    deviceId,
    packageName: SPARK_PACKAGE_NAME,
    certSha256: SPARK_CERT_SHA256,
    appVersion: SPARK_APP_VERSION,
  }
}

export async function refreshConfiguredAndroidToken(
  baseUrl: string,
): Promise<string | null> {
  const refreshToken = getConfiguredAuthRefreshToken()
  const device = getStoredSparkAndroidDevice()
  if (!refreshToken || !device) return null

  let response: Response
  try {
    response = await fetch(`${baseUrl}${ANDROID_AUTH_REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': getUserAgent(),
      },
      body: JSON.stringify({
        refresh_token: refreshToken,
        install_id: device.installId,
        device_id: device.deviceId,
        package_name: device.packageName,
        cert_sha256: device.certSha256,
        app_version: device.appVersion,
      }),
    })
  } catch {
    return null
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearConfiguredAndroidAuth()
    }
    return null
  }

  const data = await response.json()
  if (!isRecord(data)) return null

  const accessToken =
    getString(data.access_token) ?? getString(data.accessToken)
  const nextRefreshToken =
    getString(data.refresh_token) ?? getString(data.refreshToken)
  if (!accessToken || !nextRefreshToken) return null

  saveConfiguredAuthToken(accessToken)
  saveConfiguredAuthRefreshToken(nextRefreshToken)
  return accessToken
}

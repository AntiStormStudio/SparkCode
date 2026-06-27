import { feature } from 'bun:bundle'
import axios from 'axios'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { createServer, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Spinner } from '../../components/Spinner.js'
import { Box, Link, Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getConfiguredApiBaseUrl,
  normalizeApiBaseUrl,
  saveConfiguredApiBaseUrl,
  saveConfiguredAuthRefreshToken,
  saveConfiguredAuthToken,
} from '../../utils/auth.js'
import { openBrowser } from '../../utils/browser.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'
import { performLogout } from '../logout/logout.js'

type SparkLoginFormProps = {
  onDone: (success: boolean) => void
}

type SparkTokenPair = {
  accessToken: string
  refreshToken: string
}

type OAuthCallbackResult = {
  baseUrl: string
  tokenPair: SparkTokenPair
}

type LocalOAuthCallbackServer = {
  callbackUrl: string
  waitForCallback: () => Promise<OAuthCallbackResult>
  close: () => void
}

const OAUTH_TIMEOUT_MS = 10 * 60 * 1000
const OAUTH_CALLBACK_PATH = '/spark/oauth/callback'
const SPARK_OAUTH_AUTHORIZE_PATH = '/oauth2/authorize'
const SPARK_OAUTH_TOKEN_PATH = '/oauth2/token'
const SPARK_OAUTH_CLIENT_ID = 'spc_dHO3yMN-aKwgza37p2DNozfI47-SEXx9'
const SPARK_OAUTH_SCOPE = 'openid profile email'

class LoginCanceledError extends Error {}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <SparkLoginForm
      onDone={async success => {
        context.onChangeAPIKey()
        context.setMessages(stripSignatureBlocks)

        if (success) {
          resetCostState()
          void refreshRemoteManagedSettings()
          void refreshPolicyLimits()
          resetUserCache()
          refreshGrowthBookAfterAuthChange()
          clearTrustedDeviceToken()
          void enrollTrustedDevice()

          resetBypassPermissionsCheck()
          const appState = context.getAppState()
          void checkAndDisableBypassPermissionsIfNeeded(
            appState.toolPermissionContext,
            context.setAppState,
          )

          if (feature('TRANSCRIPT_CLASSIFIER')) {
            resetAutoModeGateCheck()
            void checkAndDisableAutoModeIfNeeded(
              appState.toolPermissionContext,
              context.setAppState,
              appState.fastMode,
            )
          }

          context.setAppState(prev => ({
            ...prev,
            mainLoopModelForSession: null,
            authVersion: prev.authVersion + 1,
          }))
        }

        onDone(success ? '登录成功' : '登录已取消')
      }}
    />
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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

  return status
    ? `后端返回 ${status}${detail ? `：${detail}` : ''}`
    : error.message
}

function parseOAuthTokenResponse(data: unknown): SparkTokenPair {
  if (!isRecord(data)) {
    throw new Error('后端返回的 OAuth 登录令牌数据无效')
  }

  const accessToken =
    getString(data.access_token) ?? getString(data.accessToken)
  const refreshToken =
    getString(data.refresh_token) ?? getString(data.refreshToken)

  if (!accessToken) {
    throw new Error('后端没有返回访问令牌')
  }
  if (!refreshToken) {
    throw new Error('后端没有返回刷新令牌')
  }

  return { accessToken, refreshToken }
}

function buildOAuthAuthorizeUrl(
  baseUrl: string,
  callbackUrl: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(SPARK_OAUTH_AUTHORIZE_PATH, baseUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', SPARK_OAUTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', callbackUrl)
  url.searchParams.set('scope', SPARK_OAUTH_SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

function parseOAuthCallback(
  params: URLSearchParams,
  expectedState: string,
): string {
  const error = getString(params.get('error'))
  if (error) {
    throw new Error(getString(params.get('error_description')) ?? error)
  }

  const state = getString(params.get('state'))
  if (state !== expectedState) {
    throw new Error('授权状态校验失败，请重新运行 /login')
  }

  const code = getString(params.get('code'))
  if (!code) {
    throw new Error('授权回调里没有授权码')
  }

  return code
}

function createPkceVerifier(): string {
  return randomBytes(48).toString('base64url')
}

function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function exchangeOAuthCode(
  baseUrl: string,
  code: string,
  callbackUrl: string,
  codeVerifier: string,
): Promise<SparkTokenPair> {
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: SPARK_OAUTH_CLIENT_ID,
      code,
      redirect_uri: callbackUrl,
      code_verifier: codeVerifier,
    })
    const response = await axios.post(
      `${baseUrl}${SPARK_OAUTH_TOKEN_PATH}`,
      body.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15_000,
      },
    )
    return parseOAuthTokenResponse(response.data)
  } catch (error) {
    throw new Error(`换取登录令牌失败：${describeHttpError(error)}`)
  }
}

function writeHtml(res: ServerResponse, title: string, body: string): void {
  const safeTitle = escapeHtml(title)
  const safeBody = escapeHtml(body)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fb; color: #172033; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(420px, calc(100vw - 32px)); background: white; border: 1px solid #d9e0ea; border-radius: 12px; padding: 26px; box-shadow: 0 18px 45px rgba(23, 32, 51, .10); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0; color: #5d6a7c; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <p>${safeBody}</p>
  </main>
</body>
</html>`)
}

async function startLocalOAuthCallbackServer(
  baseUrl: string,
  state: string,
  codeVerifier: string,
): Promise<LocalOAuthCallbackServer> {
  return new Promise((resolve, reject) => {
    let settled = false
    let resolveCallback: ((value: OAuthCallbackResult) => void) | null = null
    let rejectCallback: ((reason?: unknown) => void) | null = null

    const callbackPromise = new Promise<OAuthCallbackResult>(
      (resolvePromise, rejectPromise) => {
        resolveCallback = resolvePromise
        rejectCallback = rejectPromise
      },
    )

    function resolveOnce(value: OAuthCallbackResult): void {
      if (settled) return
      settled = true
      resolveCallback?.(value)
    }

    function rejectOnce(error: unknown): void {
      if (settled) return
      settled = true
      rejectCallback?.(error)
    }

    const server = createServer((req, res) => {
      void (async () => {
        const requestUrl = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? '127.0.0.1'}`,
        )

        if (requestUrl.pathname === '/favicon.ico') {
          res.writeHead(204)
          res.end()
          return
        }

        if (requestUrl.pathname !== OAUTH_CALLBACK_PATH) {
          writeHtml(res, '等待 OAuth 回调', '请在后端授权页面完成登录。')
          return
        }

        const code = parseOAuthCallback(
          requestUrl.searchParams,
          state,
        )
        const address = server.address() as AddressInfo
        const callbackUrl = `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`
        const tokenPair = await exchangeOAuthCode(baseUrl, code, callbackUrl, codeVerifier)

        resolveOnce({ baseUrl, tokenPair })
        writeHtml(res, '登录成功', '可以关闭这个页面，回到终端继续使用。')
      })().catch(error => {
        rejectOnce(error)
        writeHtml(
          res,
          '登录失败',
          error instanceof Error ? error.message : 'OAuth 回调处理失败',
        )
      })
    })

    const timeout = setTimeout(() => {
      rejectOnce(new Error('等待 OAuth 回调超时，请重新运行 /login'))
    }, OAUTH_TIMEOUT_MS)

    function closeServer(): void {
      clearTimeout(timeout)
      server.close()
    }

    callbackPromise.finally(closeServer).catch(() => {})

    server.once('error', error => {
      closeServer()
      reject(error)
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        callbackUrl: `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`,
        waitForCallback: () => callbackPromise,
        close: () => rejectOnce(new LoginCanceledError('登录已取消')),
      })
    })
  })
}

export function SparkLoginForm({ onDone }: SparkLoginFormProps): React.ReactNode {
  const [step, setStep] = useState<'starting' | 'waiting' | 'saving' | 'error'>(
    'starting',
  )
  const [authUrl, setAuthUrl] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [openBrowserWarning, setOpenBrowserWarning] = useState('')
  const [error, setError] = useState<string>('')
  const serverRef = useRef<LocalOAuthCallbackServer | null>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    let active = true

    async function run(): Promise<void> {
      try {
        const configuredBaseUrl = getConfiguredApiBaseUrl()
        if (!configuredBaseUrl) {
          throw new Error('请先运行 /config-server <后端地址> 配置项目后端')
        }

        const normalizedBaseUrl = normalizeApiBaseUrl(configuredBaseUrl)
        const state = randomUUID()
        const codeVerifier = createPkceVerifier()
        const codeChallenge = createPkceChallenge(codeVerifier)
        const server = await startLocalOAuthCallbackServer(
          normalizedBaseUrl,
          state,
          codeVerifier,
        )
        const nextAuthUrl = buildOAuthAuthorizeUrl(
          normalizedBaseUrl,
          server.callbackUrl,
          state,
          codeChallenge,
        )

        if (!active) {
          server.close()
          return
        }

        serverRef.current = server
        setBaseUrl(normalizedBaseUrl)
        setAuthUrl(nextAuthUrl)
        setStep('waiting')

        const opened = await openBrowser(nextAuthUrl)
        if (!opened) {
          setOpenBrowserWarning('未能自动打开浏览器，请手动访问下方链接')
        }

        const result = await server.waitForCallback()
        if (!active) return

        setStep('saving')
        await performLogout({ clearOnboarding: false })
        saveConfiguredApiBaseUrl(result.baseUrl)
        saveConfiguredAuthToken(result.tokenPair.accessToken)
        saveConfiguredAuthRefreshToken(result.tokenPair.refreshToken)
        saveGlobalConfig(current => ({
          ...current,
          hasCompletedOnboarding: true,
        }))

        doneRef.current = true
        onDone(true)
      } catch (err) {
        if (!active) return
        if (err instanceof LoginCanceledError) {
          doneRef.current = true
          onDone(false)
          return
        }
        setError(err instanceof Error ? err.message : '登录失败')
        setStep('error')
      }
    }

    void run()

    return () => {
      active = false
      if (!doneRef.current) {
        serverRef.current?.close()
      }
      serverRef.current = null
    }
    // onDone is stable for this command lifecycle; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Dialog
      title="SparkCode 登录"
      subtitle="OAuth 授权"
      onCancel={() => {
        doneRef.current = true
        serverRef.current?.close()
        onDone(false)
      }}
      color="permission"
      isCancelActive={step !== 'saving'}
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>再按一次 {exitState.keyName} 退出</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="取消"
          />
        )
      }
    >
      <Box flexDirection="column" gap={1}>
        {step === 'starting' && (
          <Box>
            <Spinner />
            <Text>正在启动 OAuth 登录…</Text>
          </Box>
        )}

        {step === 'waiting' && (
          <>
            <Text>请在浏览器中完成后端 OAuth 授权：</Text>
            {authUrl && (
              <Link url={authUrl}>
                <Text>{authUrl}</Text>
              </Link>
            )}
            {baseUrl && <Text dimColor>后端：{baseUrl}</Text>}
            {openBrowserWarning && (
              <Text color="warning">{openBrowserWarning}</Text>
            )}
          </>
        )}

        {(step === 'saving' || step === 'error') && (
          <Box>
            {step === 'saving' ? (
              <>
                <Spinner />
                <Text>正在保存登录信息...</Text>
              </>
            ) : (
              <Text color="error">登录失败</Text>
            )}
          </Box>
        )}

        {error && <Text color="error">{error}</Text>}
      </Box>
    </Dialog>
  )
}

import { feature } from 'bun:bundle'
import { createServer, type IncomingMessage } from 'http'
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
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Link, Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getConfiguredApiBaseUrl,
  normalizeApiBaseUrl,
  saveApiKey,
  saveConfiguredApiBaseUrl,
} from '../../utils/auth.js'
import { openBrowser } from '../../utils/browser.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { resetUserCache } from '../../utils/user.js'
import { performLogout } from '../logout/logout.js'

type SparkLoginFormProps = {
  onDone: (success: boolean, defaultModel?: string) => void
}

type WebLoginSubmitPayload = {
  baseUrl: string
  apiKey: string
  defaultModel: string
}

type WebLoginServer = {
  url: string
  waitForSubmit: () => Promise<WebLoginSubmitPayload>
  close: () => void
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <SparkLoginForm
      onDone={async (success, defaultModel) => {
        context.onChangeAPIKey()
        // Signature-bearing blocks are bound to API key; clear stale signatures.
        context.setMessages(stripSignatureBlocks)

        if (success) {
          // Post-login refresh logic. Keep in sync with onboarding in src/interactiveHelpers.tsx
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
            mainLoopModel: defaultModel?.trim() || prev.mainLoopModel,
            mainLoopModelForSession: null,
            authVersion: prev.authVersion + 1,
          }))
        }

        onDone(success ? '登录成功' : '登录已取消')
      }}
    />
  )
}

const WEB_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderLoginPage(opts: {
  values: { baseUrl: string; defaultModel: string; apiKey: string }
  error?: string
}): string {
  const errorBlock = opts.error
    ? `<div class="error">${escapeHtml(opts.error)}</div>`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SPARK 登录</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    body { margin: 0; background: #f5f7fb; color: #0f172a; }
    .wrap { max-width: 560px; margin: 48px auto; padding: 24px; background: #fff; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0 0 18px; color: #475569; }
    label { display: block; margin: 14px 0 6px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; }
    input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
    .tip { margin-top: 8px; color: #64748b; font-size: 12px; }
    button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 11px 14px; background: #2563eb; color: #fff; font-size: 14px; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .error { margin: 12px 0 2px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 10px; padding: 10px 12px; font-size: 13px; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>SPARK 登录</h1>
    <p>请输入基础地址、API 密钥和默认模型。提交后将自动回到终端完成登录。</p>
    ${errorBlock}
    <form action="/submit" method="post" autocomplete="off">
      <label for="baseurl">基础地址（BaseURL）</label>
      <input id="baseurl" name="baseurl" type="text" required placeholder="https://api.example.com" value="${escapeHtml(opts.values.baseUrl)}" />
      <div class="tip">不要带 /v1 或路径。</div>

      <label for="apikey">API 密钥</label>
      <input id="apikey" name="apikey" type="password" required autocomplete="off" value="${escapeHtml(opts.values.apiKey)}" />

      <label for="defaultModel">默认模型</label>
      <input id="defaultModel" name="defaultModel" type="text" required placeholder="sonnet / opus / haiku 或完整模型 ID" value="${escapeHtml(opts.values.defaultModel)}" />
      <div class="tip">例如：sonnet、opus、haiku，或完整模型 ID。</div>

      <button type="submit">保存并登录</button>
    </form>
  </main>
</body>
</html>`
}

const MAX_LOGIN_BODY_SIZE = 16 * 1024

async function readLoginRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = ''
    let settled = false
    req.setEncoding('utf8')
    req.on('data', chunk => {
      if (settled) {
        return
      }
      body += chunk
      if (body.length > MAX_LOGIN_BODY_SIZE) {
        settled = true
        reject(new Error('提交内容过大，请重试'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve(body)
      }
    })
    req.on('error', error => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function renderSuccessPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>登录成功</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0fdf4; color: #14532d; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px 22px; max-width: 520px; box-shadow: 0 8px 24px rgba(0,0,0,.06); }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0; color: #166534; }
  </style>
</head>
<body>
  <div class="card">
    <h1>登录信息已提交</h1>
    <p>请返回终端，继续完成登录。</p>
  </div>
</body>
</html>`
}

async function startWebLoginServer(initialValues: {
  baseUrl: string
  defaultModel: string
}): Promise<WebLoginServer> {
  return new Promise((resolve, reject) => {
    let finished = false
    let resolveSubmit: ((value: WebLoginSubmitPayload) => void) | null = null
    let rejectSubmit: ((reason?: unknown) => void) | null = null

    const submitPromise = new Promise<WebLoginSubmitPayload>(
      (resolvePromise, rejectPromise) => {
        resolveSubmit = resolvePromise
        rejectSubmit = rejectPromise
      },
    )

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
      let formData = requestUrl.searchParams
      if (requestUrl.pathname === '/submit') {
        if (req.method !== 'POST') {
          res.writeHead(405, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(
            renderLoginPage({
              values: {
                baseUrl: initialValues.baseUrl,
                apiKey: '',
                defaultModel: initialValues.defaultModel,
              },
              error: '提交方式无效，请刷新页面后重试',
            }),
          )
          return
        }
        const rawBody = await readLoginRequestBody(req)
        formData = new URLSearchParams(rawBody)
      }

      const baseUrlRaw = (formData.get('baseurl') ?? '').trim()
      const apiKeyRaw = (formData.get('apikey') ?? '').trim()
      const modelRaw = (formData.get('defaultModel') ?? '').trim()

      if (requestUrl.pathname === '/submit') {
        try {
          if (!baseUrlRaw) {
            throw new Error('BaseURL 不能为空')
          }
          if (!apiKeyRaw) {
            throw new Error('API Key 不能为空')
          }
          if (!modelRaw) {
            throw new Error('默认模型不能为空')
          }

          const normalizedBaseUrl = normalizeApiBaseUrl(baseUrlRaw)
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(renderSuccessPage())
          resolveSubmit?.({
            baseUrl: normalizedBaseUrl,
            apiKey: apiKeyRaw,
            defaultModel: modelRaw,
          })
          return
        } catch (error) {
          res.writeHead(400, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(
            renderLoginPage({
              values: {
                baseUrl: baseUrlRaw,
                apiKey: '',
                defaultModel: modelRaw || initialValues.defaultModel,
              },
              error: error instanceof Error ? error.message : '输入格式无效',
            }),
          )
          return
        }
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(
        renderLoginPage({
          values: {
            baseUrl: initialValues.baseUrl,
            apiKey: '',
            defaultModel: initialValues.defaultModel,
          },
        }),
      )
      })().catch(error => {
        res.writeHead(500, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(
          renderLoginPage({
            values: {
              baseUrl: initialValues.baseUrl,
              apiKey: '',
              defaultModel: initialValues.defaultModel,
            },
            error: error instanceof Error ? error.message : '服务端处理失败',
          }),
        )
      })
    })

    const timeout = setTimeout(() => {
      rejectSubmit?.(new Error('等待网页提交超时，请重新运行 /login'))
    }, WEB_LOGIN_TIMEOUT_MS)

    const closeServer = (): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timeout)
      server.close()
    }

    server.once('error', err => {
      closeServer()
      reject(err)
    })

    submitPromise.finally(closeServer).catch(() => {})

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      const url = `http://127.0.0.1:${address.port}/`
      resolve({
        url,
        waitForSubmit: () => submitPromise,
        close: () => {
          closeServer()
          rejectSubmit?.(new Error('登录流程已取消'))
        },
      })
    })
  })
}

export function SparkLoginForm({ onDone }: SparkLoginFormProps): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const defaultModelRef = useRef(mainLoopModel)
  const [step, setStep] = useState<
    'starting' | 'waiting' | 'saving' | 'error'
  >('starting')
  const [webUrl, setWebUrl] = useState('')
  const [openBrowserWarning, setOpenBrowserWarning] = useState('')
  const [error, setError] = useState<string>('')
  const webServerRef = useRef<WebLoginServer | null>(null)

  useEffect(() => {
    let active = true

    async function run(): Promise<void> {
      try {
        const server = await startWebLoginServer({
          baseUrl: getConfiguredApiBaseUrl() ?? '',
          defaultModel: defaultModelRef.current,
        })

        if (!active) {
          server.close()
          return
        }

        webServerRef.current = server
        setWebUrl(server.url)
        setStep('waiting')

        const opened = await openBrowser(server.url)
        if (!opened) {
          setOpenBrowserWarning('未能自动打开浏览器，请手动访问下方链接')
        }

        const form = await server.waitForSubmit()
        if (!active) {
          return
        }

        setStep('saving')

        // Clear OAuth/session artifacts so login is API-key only.
        await performLogout({ clearOnboarding: false })
        saveConfiguredApiBaseUrl(form.baseUrl)
        await saveApiKey(form.apiKey)

        const updateResult = updateSettingsForSource('userSettings', {
          model: form.defaultModel,
        })
        if (updateResult.error) {
          throw updateResult.error
        }

        onDone(true, form.defaultModel)
      } catch (err) {
        if (!active) {
          return
        }
        setError(err instanceof Error ? err.message : '登录失败')
        setStep('error')
      }
    }

    void run()

    return () => {
      active = false
      webServerRef.current?.close()
      webServerRef.current = null
    }
    // onDone is stable for this command lifecycle; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Dialog
      title="SPARK 登录"
      subtitle="已打开网页，请在浏览器输入基础地址、API 密钥、默认模型"
      onCancel={() => {
        webServerRef.current?.close()
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
            <Text>正在启动网页登录...</Text>
          </Box>
        )}

        {step === 'waiting' && (
          <>
            <Text>请在浏览器页面完成输入并提交：</Text>
            {webUrl && (
              <Link url={webUrl}>
                <Text>{webUrl}</Text>
              </Link>
            )}
            {openBrowserWarning && <Text color="warning">{openBrowserWarning}</Text>}
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

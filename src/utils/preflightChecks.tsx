import axios from 'axios'
import React, { useEffect, useState } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { Spinner } from '../components/Spinner.js'
import { Select } from '../components/CustomSelect/select.js'
import { getOauthConfig } from '../constants/oauth.js'
import { useTimeout } from '../hooks/useTimeout.js'
import { Box, Text } from '../ink.js'
import { getSSLErrorHint } from '../services/api/errorUtils.js'
import { getUserAgent } from './http.js'
import { logError } from './log.js'

export interface PreflightCheckResult {
  success: boolean
  error?: string
  sslHint?: string
}

const PREFLIGHT_REQUEST_TIMEOUT_MS = 10_000

function formatEndpointError(url: string, err: unknown): PreflightCheckResult {
  const hostname = new URL(url).hostname
  const sslHint = getSSLErrorHint(err)
  const errno =
    err instanceof Error
      ? ((err as NodeJS.ErrnoException).code ?? err.message)
      : String(err)
  return {
    success: false,
    error: `连接 ${hostname} 失败：${errno}`,
    sslHint: sslHint ?? undefined,
  }
}

async function checkEndpoint(url: string): Promise<PreflightCheckResult> {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': getUserAgent() },
      timeout: PREFLIGHT_REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    })
    if (response.status < 200 || response.status >= 300) {
      const hostname = new URL(url).hostname
      return {
        success: false,
        error: `连接 ${hostname} 失败：HTTP ${response.status}`,
      }
    }
    return { success: true }
  } catch (error) {
    return formatEndpointError(url, error)
  }
}

async function checkEndpoints(): Promise<PreflightCheckResult> {
  try {
    const oauthConfig = getOauthConfig()
    const tokenUrl = new URL(oauthConfig.TOKEN_URL)
    const endpoints = [
      `${oauthConfig.BASE_API_URL}/api/hello`,
      `${tokenUrl.origin}/v1/oauth/hello`,
    ]
    const results = await Promise.all(endpoints.map(checkEndpoint))
    const failedResult = results.find(result => !result.success)

    if (failedResult) {
      logEvent('tengu_preflight_check_failed', {
        isConnectivityError: false,
        hasErrorMessage: !!failedResult.error,
        isSSLError: !!failedResult.sslHint,
      })
      return failedResult
    }

    return { success: true }
  } catch (error) {
    logError(error as Error)
    logEvent('tengu_preflight_check_failed', { isConnectivityError: true })
    const errno =
      error instanceof Error
        ? ((error as NodeJS.ErrnoException).code ?? error.message)
        : String(error)
    return {
      success: false,
      error: `网络连通性检查异常：${errno}`,
    }
  }
}

interface PreflightStepProps {
  onSuccess: () => void
}

export function PreflightStep({
  onSuccess,
}: PreflightStepProps): React.ReactNode {
  const [result, setResult] = useState<PreflightCheckResult | null>(null)
  const [isChecking, setIsChecking] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const showSpinner = useTimeout(1000) && isChecking

  useEffect(() => {
    let cancelled = false
    setIsChecking(true)
    setResult(null)

    async function run(): Promise<void> {
      const checkResult = await checkEndpoints()
      if (cancelled) {
        return
      }
      setResult(checkResult)
      setIsChecking(false)
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [attempt])

  useEffect(() => {
    if (result?.success) {
      onSuccess()
    }
  }, [result, onSuccess])

  if (isChecking && showSpinner) {
    return (
      <Box paddingLeft={1}>
        <Spinner />
        <Text>正在检查网络连通性...</Text>
      </Box>
    )
  }

  if (!result?.success && !isChecking) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">无法连接 Spark 服务</Text>
        {result?.error && <Text color="error">{result.error}</Text>}
        {result?.sslHint ? (
          <Box flexDirection="column" gap={1}>
            <Text>{result.sslHint}</Text>
            <Text color="suggestion">
              参考：https://spark-ai.top/docs/zh-CN/network-config
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Text>请检查你的网络连接、代理和防火墙设置。</Text>
            <Text>
              若为区域限制，请参考：
              <Text color="suggestion">https://spark-ai.top/supported-countries</Text>
            </Text>
          </Box>
        )}

        <Select
          options={[
            { label: '1. 重试网络检查', value: 'retry' },
            { label: '2. 跳过并继续', value: 'skip' },
          ]}
          onChange={value => {
            if (value === 'retry') {
              setAttempt(prev => prev + 1)
              return
            }
            onSuccess()
          }}
          onCancel={() => setAttempt(prev => prev + 1)}
        />
        <Text dimColor>Enter 确认 · Esc 重试</Text>
      </Box>
    )
  }

  return null
}

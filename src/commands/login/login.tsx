import { feature } from 'bun:bundle'
import * as React from 'react'
import { useState } from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Spinner } from '../../components/Spinner.js'
import TextInput from '../../components/TextInput.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Text } from '../../ink.js'
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
  onDone: (success: boolean, mainLoopModel: string) => void
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <SparkLoginForm
      onDone={async success => {
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
            authVersion: prev.authVersion + 1,
          }))
        }

        onDone(success ? '登录成功' : '登录已取消')
      }}
    />
  )
}

export function SparkLoginForm({ onDone }: SparkLoginFormProps): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const [baseUrlInput, setBaseUrlInput] = useState(
    () => getConfiguredApiBaseUrl() ?? '',
  )
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [normalizedBaseUrl, setNormalizedBaseUrl] = useState('')
  const [step, setStep] = useState<'baseurl' | 'apikey' | 'saving'>('baseurl')
  const [error, setError] = useState<string>('')

  async function handleBaseUrlSubmit(value: string): Promise<void> {
    try {
      const normalized = normalizeApiBaseUrl(value)
      setNormalizedBaseUrl(normalized)
      setBaseUrlInput(normalized)
      setError('')
      setStep('apikey')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'BASEURL 格式无效')
    }
  }

  async function handleApiKeySubmit(value: string): Promise<void> {
    const trimmedKey = value.trim()
    if (!trimmedKey) {
      setError('APIKEY 不能为空')
      return
    }

    setStep('saving')
    setError('')

    try {
      // Clear OAuth/session artifacts so login is API-key only.
      await performLogout({ clearOnboarding: false })
      saveConfiguredApiBaseUrl(normalizedBaseUrl)
      await saveApiKey(trimmedKey)
      onDone(true, mainLoopModel)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存凭证失败')
      setStep('apikey')
    }
  }

  return (
    <Dialog
      title="SPARK 登录"
      subtitle="输入 BASEURL（不带 /v1）和 APIKEY"
      onCancel={() => onDone(false, mainLoopModel)}
      color="permission"
      isCancelActive={step !== 'saving'}
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
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
        {step === 'baseurl' && (
          <>
            <Text>请输入 BASEURL（示例: https://api.example.com）</Text>
            <Box>
              <Text>BASEURL: </Text>
              <TextInput value={baseUrlInput} onChange={setBaseUrlInput} onSubmit={handleBaseUrlSubmit} />
            </Box>
          </>
        )}

        {step === 'apikey' && (
          <>
            <Text dimColor>BASEURL: {baseUrlInput}</Text>
            <Text>请输入 APIKEY</Text>
            <Box>
              <Text>APIKEY: </Text>
              <TextInput
                value={apiKeyInput}
                onChange={setApiKeyInput}
                onSubmit={handleApiKeySubmit}
                mask="*"
              />
            </Box>
          </>
        )}

        {step === 'saving' && (
          <Box>
            <Spinner />
            <Text>正在保存登录信息...</Text>
          </Box>
        )}

        {error && <Text color="error">{error}</Text>}
      </Box>
    </Dialog>
  )
}

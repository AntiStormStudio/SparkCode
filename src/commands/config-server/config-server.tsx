import * as React from 'react'
import { useEffect, useState } from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import TextInput from '../../components/TextInput.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  clearConfiguredAuthRefreshToken,
  clearConfiguredAuthToken,
  getConfiguredApiBaseUrl,
  saveConfiguredApiBaseUrl,
} from '../../utils/auth.js'

type CommandContext = Parameters<LocalJSXCommandCall>[1]

function markServerChanged(context: CommandContext): void {
  context.onChangeAPIKey()
  context.setAppState(prev => ({
    ...prev,
    authVersion: prev.authVersion + 1,
  }))
}

type SaveServerUrlResult = {
  normalized: string
  clearedLogin: boolean
}

function saveServerUrl(
  rawValue: string,
  context: CommandContext,
): SaveServerUrlResult {
  const previous = getConfiguredApiBaseUrl()
  const normalized = saveConfiguredApiBaseUrl(rawValue)
  const clearedLogin = previous !== normalized
  if (clearedLogin) {
    clearConfiguredAuthToken()
    clearConfiguredAuthRefreshToken()
  }
  markServerChanged(context)
  return { normalized, clearedLogin }
}

function formatSavedMessage(result: SaveServerUrlResult): string {
  return result.clearedLogin
    ? `后端地址已更新：${result.normalized}，已清除旧登录态，请重新运行 /login`
    : `后端地址已更新：${result.normalized}`
}

function ApplyServerAndClose({
  args,
  context,
  onDone,
}: {
  args: string
  context: CommandContext
  onDone: (result: string) => void
}): React.ReactNode {
  useEffect(() => {
    try {
      const result = saveServerUrl(args, context)
      onDone(formatSavedMessage(result))
    } catch (error) {
      onDone(error instanceof Error ? error.message : '后端地址设置失败')
    }
  }, [args, context, onDone])

  return null
}

function ConfigServerDialog({
  context,
  onDone,
}: {
  context: CommandContext
  onDone: (result: string) => void
}): React.ReactNode {
  const current = getConfiguredApiBaseUrl() ?? ''
  const [value, setValue] = useState(current)
  const [cursorOffset, setCursorOffset] = useState(current.length)
  const [error, setError] = useState('')

  function handleSubmit(nextValue: string): void {
    try {
      const result = saveServerUrl(nextValue, context)
      onDone(formatSavedMessage(result))
    } catch (err) {
      setError(err instanceof Error ? err.message : '后端地址设置失败')
    }
  }

  return (
    <Dialog
      title="配置后端地址"
      subtitle="用于 /login 和后续 API 请求"
      onCancel={() => onDone('已取消配置后端地址')}
      color="permission"
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
        <Text>请输入后端基础地址：</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          columns={80}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          focus
          showCursor
        />
        <Text dimColor>只填协议、域名和端口，不要带 /v1 或其他路径。</Text>
        {error && <Text color="error">{error}</Text>}
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args = '') => {
  const trimmed = args.trim()
  if (trimmed) {
    return (
      <ApplyServerAndClose
        args={trimmed}
        context={context}
        onDone={onDone}
      />
    )
  }

  return <ConfigServerDialog context={context} onDone={onDone} />
}

import * as React from 'react'
import { useEffect, useState } from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import TextInput from '../../components/TextInput.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  bindSparkCodeClient,
  clearSparkCodeCredentials,
  getDefaultSparkCodeEndpoint,
  getSparkCodeClientMe,
  getSparkCodeCredentials,
  getSparkCodeStatus,
  normalizeSparkCodeEndpoint,
  upsertSparkCodeCurrentSession,
} from '../../services/sparkCode/client.js'
import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { startSparkCodeRemoteBridge } from '../../services/sparkCode/remoteBridge.js'

type SaveRemoteBackendResult = {
  backendUrl?: string
}

function normalizeRemoteBackendUrl(rawValue: string): string | undefined {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return undefined
  }
  return normalizeSparkCodeEndpoint(trimmed)
}

function getConfiguredRemoteEndpoint(): string {
  return (
    getSettings_DEPRECATED()?.remote?.backendUrl ??
    getSparkCodeCredentials()?.endpoint ??
    getDefaultSparkCodeEndpoint()
  )
}

function saveRemoteBackendUrl(rawValue: string): SaveRemoteBackendResult {
  const previous = getSettings_DEPRECATED()?.remote?.backendUrl
  const backendUrl = normalizeRemoteBackendUrl(rawValue)
  const result = updateSettingsForSource('userSettings', {
    remote: {
      backendUrl,
    },
  })

  if (result.error) {
    throw result.error
  }

  if (previous !== backendUrl) {
    clearSparkCodeCredentials()
  }

  return { backendUrl }
}

function formatSavedMessage(result: SaveRemoteBackendResult): string {
  return result.backendUrl
    ? `Remote 后端地址已更新：${result.backendUrl}`
    : 'Remote 后端地址已清除'
}

function ApplyRemoteBackendAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (result: string) => void
}): React.ReactNode {
  useEffect(() => {
    try {
      onDone(formatSavedMessage(saveRemoteBackendUrl(args)))
    } catch (error) {
      onDone(error instanceof Error ? error.message : 'Remote 后端地址设置失败')
    }
  }, [args, onDone])

  return null
}

function RemoteBackendDialog({
  onDone,
}: {
  onDone: (result: string) => void
}): React.ReactNode {
  const current = getSettings_DEPRECATED()?.remote?.backendUrl ?? getDefaultSparkCodeEndpoint()
  const [value, setValue] = useState(current)
  const [cursorOffset, setCursorOffset] = useState(current.length)
  const [error, setError] = useState('')

  function handleSubmit(nextValue: string): void {
    try {
      const result = saveRemoteBackendUrl(nextValue)
      onDone(formatSavedMessage(result))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remote 后端地址设置失败')
    }
  }

  return (
    <Dialog
      title="配置 Remote 后端"
      subtitle="用于远程控制转发服务器"
      onCancel={() => onDone('已取消配置 Remote 后端')}
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
        <Text>请输入 Remote 后端地址：</Text>
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
        <Box flexDirection="column">
          <Text dimColor>留空并回车可清除当前地址。</Text>
          <Text dimColor>/remote bind 123456-654321 绑定客户端。</Text>
          <Text dimColor>/remote status 查看后端和绑定状态。</Text>
          <Text dimColor>/remote session [标题] 同步当前会话。</Text>
        </Box>
        {error && <Text color="error">{error}</Text>}
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args = '') => {
  const trimmed = args.trim()
  const [command = '', ...rest] = trimmed.split(/\s+/)
  const commandArgs = rest.join(' ').trim()

  if (command === 'bind' || /^\d{6}-\d{6}$/.test(trimmed)) {
    const code = command === 'bind' ? commandArgs : trimmed
    if (!code) {
      onDone('请提供绑定码：/remote bind 123456-654321')
      return null
    }
    const endpoint = getConfiguredRemoteEndpoint()
    try {
      const credentials = await bindSparkCodeClient(endpoint, code)
      startSparkCodeRemoteBridge()
      onDone(`Remote 已绑定：${credentials.endpoint}`)
    } catch (error) {
      onDone(error instanceof Error ? error.message : 'Remote 绑定失败')
    }
    return null
  }

  if (command === 'status') {
    const endpoint = getConfiguredRemoteEndpoint()
    try {
      const protocol = await getSparkCodeStatus(endpoint)
      const credentials = getSparkCodeCredentials()
      if (!credentials) {
        onDone(
          `Remote 后端可用：${protocol.name} ${protocol.protocol_version}；尚未绑定客户端`,
        )
        return null
      }
      const binding = await getSparkCodeClientMe(credentials)
      onDone(
        `Remote 后端可用：${protocol.name} ${protocol.protocol_version}；客户端已绑定：${binding.client_name ?? binding.name}`,
      )
    } catch (error) {
      onDone(error instanceof Error ? error.message : 'Remote 状态检查失败')
    }
    return null
  }

  if (command === 'session') {
    const credentials = getSparkCodeCredentials()
    if (!credentials) {
      onDone('尚未绑定 Remote 客户端，请先运行 /remote bind <绑定码>')
      return null
    }
    try {
      const session = await upsertSparkCodeCurrentSession(
        credentials,
        commandArgs || undefined,
      )
      startSparkCodeRemoteBridge()
      onDone(`Remote 会话已同步：${session.title} (${session.id})`)
    } catch (error) {
      onDone(error instanceof Error ? error.message : 'Remote 会话同步失败')
    }
    return null
  }

  if (['unbind', 'logout', 'disconnect'].includes(command)) {
    clearSparkCodeCredentials()
    onDone('Remote 本地绑定已清除')
    return null
  }

  if (trimmed) {
    return <ApplyRemoteBackendAndClose args={trimmed} onDone={onDone} />
  }

  return <RemoteBackendDialog onDone={onDone} />
}

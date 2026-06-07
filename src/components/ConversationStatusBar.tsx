import * as React from 'react'
import { getSdkBetas, getSessionId } from '../bootstrap/state.js'
import { getTotalInputTokens, getTotalOutputTokens } from '../cost-tracker.js'
import { useSettings } from '../hooks/useSettings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import type { Message } from '../types/message.js'
import { getContextWindowForModel } from '../utils/context.js'
import { formatTokens, truncateToWidth } from '../utils/format.js'
import { tokenCountWithEstimation } from '../utils/tokens.js'

type Props = {
  messages: readonly Message[]
  mainLoopModel: string
  title: string
  visible: boolean
}

export function ConversationStatusBar({
  messages,
  mainLoopModel,
  title,
  visible,
}: Props): React.ReactNode {
  const settings = useSettings()
  const { columns } = useTerminalSize()

  const status = React.useMemo(() => {
    if (!visible) {
      return null
    }

    const sessionId = getSessionId()
    const shortId = sessionId.slice(0, 8)
    const totalTokens = getTotalInputTokens() + getTotalOutputTokens()
    const contextTokens = tokenCountWithEstimation(messages)
    const contextWindow = getContextWindowForModel(mainLoopModel, getSdkBetas())
    const remoteConfigured = !!settings?.remote?.backendUrl
    const remoteLabel = remoteConfigured ? 'Y' : 'N'
    const prefix = `ID: ${shortId} T: `
    const totalTokenText = formatTokens(totalTokens)
    const contextTokenText = formatTokens(contextTokens)
    const contextWindowText = formatTokens(contextWindow)
    const suffix = ` TK:${totalTokenText} toks C: ${contextTokenText}/${contextWindowText} R: ${remoteLabel}`
    const titleBudget = Math.max(10, columns - prefix.length - suffix.length - 4)
    const safeTitle = truncateToWidth(title || 'SparkCode', titleBudget)

    return {
      contextTokenText,
      contextWindowText,
      remoteConfigured,
      remoteLabel,
      safeTitle,
      shortId,
      totalTokenText,
    }
  }, [columns, mainLoopModel, messages, settings?.remote?.backendUrl, title, visible])

  if (!status) {
    return null
  }

  return (
    <Box flexShrink={0} paddingX={2} width="100%">
      <Text wrap="truncate">
        <Text dimColor>ID: </Text>
        <Text color="permission" bold>
          {status.shortId}
        </Text>
        <Text dimColor> T: </Text>
        <Text color="text">{status.safeTitle}</Text>
        <Text dimColor> TK:</Text>
        <Text color="warning">{status.totalTokenText}</Text>
        <Text dimColor> toks C: </Text>
        <Text color="suggestion">{status.contextTokenText}</Text>
        <Text dimColor>/</Text>
        <Text color="permission">{status.contextWindowText}</Text>
        <Text dimColor> R: </Text>
        <Text color={status.remoteConfigured ? 'success' : 'warning'} bold>
          {status.remoteLabel}
        </Text>
      </Text>
    </Box>
  )
}

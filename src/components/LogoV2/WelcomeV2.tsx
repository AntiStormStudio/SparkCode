import React from 'react'
import { Box, Text, useTheme } from 'src/ink.js'
import { env } from '../../utils/env.js'
import { Clawd } from './Clawd.js'

const WELCOME_V2_WIDTH = 58
const WELCOME_MESSAGE = '欢迎使用 SparkCode'

type AppleTerminalWelcomeV2Props = {
  theme: string
  welcomeMessage: string
}

function WelcomeHeader({
  welcomeMessage,
}: {
  welcomeMessage: string
}): React.ReactNode {
  return (
    <Text>
      <Text color="claude">{welcomeMessage} </Text>
      <Text dimColor>v{MACRO.VERSION}</Text>
    </Text>
  )
}

function AppleTerminalWelcomeV2({
  theme,
  welcomeMessage,
}: AppleTerminalWelcomeV2Props): React.ReactNode {
  void theme

  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column" alignItems="center">
      <WelcomeHeader welcomeMessage={welcomeMessage} />
      <Clawd />
    </Box>
  )
}

export function WelcomeV2(): React.ReactNode {
  const [theme] = useTheme()

  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalWelcomeV2 theme={theme} welcomeMessage={WELCOME_MESSAGE} />
  }

  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column" alignItems="center">
      <WelcomeHeader welcomeMessage={WELCOME_MESSAGE} />
      <Clawd />
    </Box>
  )
}

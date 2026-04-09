import * as React from 'react'
import { Box, Text } from '../../ink.js'

export type ClawdPose =
  | 'default'
  | 'arms-up'
  | 'look-left'
  | 'look-right'

type Props = {
  pose?: ClawdPose
}

const CLAWD_ASCII_ART = [
  ' ____    ____       _      ____    _  __',
  ' / ___|  |  _ \\     / \\    |  _ \\  | |/ /',
  " \\___ \\  | |_) |   / _ \\   | |_) | | ' / ",
  '  ___) | |  __/   / ___ \\  |  _ <  | . \\ ',
  ' |____/  |_|     /_/   \\_\\ |_| \\_\\ |_|\\_\\',
  '                                         ',
] as const

export function Clawd({ pose = 'default' }: Props = {}): React.ReactNode {
  // Keep the pose prop for API compatibility with AnimatedClawd.
  void pose

  return (
    <Box flexDirection="column" alignItems="center">
      {CLAWD_ASCII_ART.map((line, idx) => (
        <Text key={idx} color="clawd_body">
          {line}
        </Text>
      ))}
    </Box>
  )
}

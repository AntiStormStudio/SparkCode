import * as React from 'react'
import { useEffect } from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { getEffortSuffix } from '../../utils/effort.js'
import { truncate } from '../../utils/format.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import {
  formatModelAndBilling,
  getLogoDisplayData,
  truncatePath,
} from '../../utils/logoV2Utils.js'
import { renderModelSetting } from '../../utils/model/model.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { AnimatedClawd } from './AnimatedClawd.js'
import { Clawd } from './Clawd.js'
import {
  GuestPassesUpsell,
  incrementGuestPassesSeenCount,
  useShowGuestPassesUpsell,
} from './GuestPassesUpsell.js'
import {
  incrementOverageCreditUpsellSeenCount,
  OverageCreditUpsell,
  useShowOverageCreditUpsell,
} from './OverageCreditUpsell.js'

const CLAWD_ART_WIDTH = 41
const LOGO_TEXT_GAP = 1
const LOGO_DIVIDER_WIDTH = 1
const MIN_INLINE_TEXT_WIDTH = 24
const MIN_TEXT_WIDTH = 12
const BORDER_INSET = 4

export function CondensedLogo() {
  const { columns } = useTerminalSize()
  const agent = useAppState(_temp)
  const effortValue = useAppState(_temp2)
  const model = useMainLoopModel()
  const modelDisplayName = renderModelSetting(model)
  const {
    version,
    cwd,
    billingType,
    agentName: agentNameFromSettings,
  } = getLogoDisplayData()
  const agentName = agent ?? agentNameFromSettings
  const showGuestPassesUpsell = useShowGuestPassesUpsell()
  const showOverageCreditUpsell = useShowOverageCreditUpsell()

  useEffect(() => {
    if (showGuestPassesUpsell) {
      incrementGuestPassesSeenCount()
    }
  }, [showGuestPassesUpsell])

  useEffect(() => {
    if (showOverageCreditUpsell && !showGuestPassesUpsell) {
      incrementOverageCreditUpsellSeenCount()
    }
  }, [showOverageCreditUpsell, showGuestPassesUpsell])

  const availableContentWidth = Math.max(columns - BORDER_INSET, MIN_TEXT_WIDTH)
  const inlineTextWidth =
    availableContentWidth -
    CLAWD_ART_WIDTH -
    LOGO_DIVIDER_WIDTH -
    LOGO_TEXT_GAP * 2
  const shouldStack = inlineTextWidth < MIN_INLINE_TEXT_WIDTH
  const stackOuterWidth = Math.max(Math.min(columns, 52), 1)
  const stackContentWidth = Math.max(stackOuterWidth - BORDER_INSET, 1)
  const textWidth = shouldStack ? stackContentWidth : inlineTextWidth
  const titleVersionWidth = textWidth - stringWidth('SparkCode v')
  const truncatedVersion =
    titleVersionWidth >= 4 ? truncate(version, titleVersionWidth) : ''
  const effortSuffix = getEffortSuffix(model, effortValue)
  const {
    shouldSplit,
    truncatedModel,
    truncatedBilling,
  } = formatModelAndBilling(modelDisplayName + effortSuffix, billingType, textWidth)
  const cwdAvailableWidth = agentName
    ? textWidth - stringWidth('工作目录：') - 1 - stringWidth(agentName) - 3
    : textWidth - stringWidth('工作目录：')
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))
  const cwdLine = agentName
    ? `@${agentName} · 工作目录：${truncatedCwd}`
    : `工作目录：${truncatedCwd}`
  const logo = isFullscreenEnvEnabled() ? <AnimatedClawd /> : <Clawd />
  const title = truncatedVersion ? (
    <Text>
      <Text bold={true}>SparkCode</Text>{' '}
      <Text dimColor={true}>v{truncatedVersion}</Text>
    </Text>
  ) : (
    <Text bold={true}>SparkCode</Text>
  )
  const modelAndBilling = shouldSplit ? (
    <>
      <Text dimColor={true}>{truncatedModel}</Text>
      <Text dimColor={true}>{truncatedBilling}</Text>
    </>
  ) : (
    <Text dimColor={true}>
      {truncatedModel} · {truncatedBilling}
    </Text>
  )
  const guestPassesUpsell = showGuestPassesUpsell && <GuestPassesUpsell />
  const overageCreditUpsell = !showGuestPassesUpsell &&
    showOverageCreditUpsell && (
      <OverageCreditUpsell maxWidth={textWidth} twoLine={true} />
    )
  const details = (
    <Box
      flexDirection="column"
      alignItems={shouldStack ? 'center' : 'flex-start'}
      width={textWidth}
      flexShrink={0}
    >
      {title}
      {modelAndBilling}
      <Text dimColor={true}>{cwdLine}</Text>
      {guestPassesUpsell}
      {overageCreditUpsell}
    </Box>
  )

  if (shouldStack) {
    return (
      <OffscreenFreeze>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="claude"
          paddingX={1}
          paddingY={1}
          alignItems="center"
          width={stackOuterWidth}
        >
          {details}
        </Box>
      </OffscreenFreeze>
    )
  }

  return (
    <OffscreenFreeze>
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor="claude"
        paddingX={1}
        paddingY={1}
        gap={LOGO_TEXT_GAP}
        alignItems="center"
        width={
          CLAWD_ART_WIDTH +
          LOGO_DIVIDER_WIDTH +
          LOGO_TEXT_GAP * 2 +
          textWidth +
          BORDER_INSET
        }
      >
        <Box width={CLAWD_ART_WIDTH} flexShrink={0}>
          {logo}
        </Box>
        <Box
          width={LOGO_DIVIDER_WIDTH}
          height={6}
          flexShrink={0}
          borderStyle="single"
          borderColor="claude"
          borderDimColor={true}
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
        />
        {details}
      </Box>
    </OffscreenFreeze>
  )
}
function _temp2(s_0) {
  return s_0.effortValue
}
function _temp(s) {
  return s.agent
}

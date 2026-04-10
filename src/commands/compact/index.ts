import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const compact = {
  type: 'local',
  name: 'compact',
  description:
    '清空会话历史但保留上下文摘要。可选：/compact [摘要指令]',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  argumentHint: '<可选自定义摘要指令>',
  load: () => import('./compact.js'),
} satisfies Command

export default compact

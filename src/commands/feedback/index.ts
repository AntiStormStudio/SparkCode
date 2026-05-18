import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isEnvTruthy, getSparkEnv } from '../../utils/envUtils.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `提交关于 Spark Code 的反馈`,
  argumentHint: '[report]',
  isEnabled: () =>
    !(
      isEnvTruthy(getSparkEnv("USE_BEDROCK")) ||
      isEnvTruthy(getSparkEnv("USE_VERTEX")) ||
      isEnvTruthy(getSparkEnv("USE_FOUNDRY")) ||
      isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) ||
      isEnvTruthy(process.env.DISABLE_BUG_COMMAND) ||
      isEssentialTrafficOnly() ||
      process.env.USER_TYPE === 'ant' ||
      !isPolicyAllowed('allow_product_feedback')
    ),
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback

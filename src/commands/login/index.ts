import type { Command } from '../../commands.js'
import { getAuthTokenSource, hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

function hasLoginAuth(): boolean {
  return hasAnthropicApiKeyAuth() || getAuthTokenSource().hasToken
}

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: hasLoginAuth() ? '重新登录 SparkCode' : '登录 SparkCode',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command

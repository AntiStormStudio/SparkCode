/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  clearAuthRelatedCaches,
  performLogout,
} from '../../commands/logout/logout.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { fetchAndStoreClaudeCodeFirstTokenDate } from '../../services/api/firstTokenDate.js'
import {
  createAndStoreApiKey,
  fetchAndStoreUserRoles,
  shouldUseClaudeAIAuth,
  storeOAuthAccountInfo,
} from '../../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import {
  clearOAuthTokenCache,
  getConfiguredApiBaseUrl,
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  isUsing3PServices,
  saveApiKey,
  saveConfiguredApiBaseUrl,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { jsonStringify } from '../../utils/slowOperations.js'

/**
 * Shared post-token-acquisition logic. Saves tokens, fetches profile/roles,
 * and sets up the local auth state.
 */
export async function installOAuthTokens(tokens: OAuthTokens): Promise<void> {
  // Clear old state before saving new credentials
  await performLogout({ clearOnboarding: false })

  // Reuse pre-fetched profile if available, otherwise fetch fresh
  const profile =
    tokens.profile ?? (await getOauthProfileFromOauthToken(tokens.accessToken))
  if (profile) {
    storeOAuthAccountInfo({
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      organizationUuid: profile.organization.uuid,
      displayName: profile.account.display_name || undefined,
      hasExtraUsageEnabled:
        profile.organization.has_extra_usage_enabled ?? undefined,
      billingType: profile.organization.billing_type ?? undefined,
      subscriptionCreatedAt:
        profile.organization.subscription_created_at ?? undefined,
      accountCreatedAt: profile.account.created_at,
    })
  } else if (tokens.tokenAccount) {
    // Fallback to token exchange account data when profile endpoint fails
    storeOAuthAccountInfo({
      accountUuid: tokens.tokenAccount.uuid,
      emailAddress: tokens.tokenAccount.emailAddress,
      organizationUuid: tokens.tokenAccount.organizationUuid,
    })
  }

  const storageResult = saveOAuthTokensIfNeeded(tokens)
  clearOAuthTokenCache()

  if (storageResult.warning) {
    logEvent('tengu_oauth_storage_warning', {
      warning:
        storageResult.warning as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // Roles and first-token-date may fail for limited-scope tokens (e.g.
  // inference-only from setup-token). They're not required for core auth.
  await fetchAndStoreUserRoles(tokens.accessToken).catch(err =>
    logForDebugging(String(err), { level: 'error' }),
  )

  if (shouldUseClaudeAIAuth(tokens.scopes)) {
    await fetchAndStoreClaudeCodeFirstTokenDate().catch(err =>
      logForDebugging(String(err), { level: 'error' }),
    )
  } else {
    // API key creation is critical for Console users — let it throw.
    const apiKey = await createAndStoreApiKey(tokens.accessToken)
    if (!apiKey) {
      throw new Error(
        '无法创建 API Key。服务器已接受请求，但未返回 Key。',
      )
    }
  }

  await clearAuthRelatedCaches()
}

export async function authLogin({
  baseUrl,
  apiKey,
}: {
  baseUrl?: string
  apiKey?: string
}): Promise<void> {
  const normalizedApiKey = apiKey?.trim()
  if (!baseUrl || !normalizedApiKey) {
    process.stderr.write(
      'Error: --base-url 和 --api-key 都是必填参数。\n' +
        '示例: sparkc auth login --base-url https://api.example.com --api-key sk-xxxx\n',
    )
    process.exit(1)
  }

  try {
    await performLogout({ clearOnboarding: false })
    const normalizedBaseUrl = saveConfiguredApiBaseUrl(baseUrl)
    await saveApiKey(normalizedApiKey)

    // Mark onboarding complete for CLI login path.
    saveGlobalConfig(current => {
      if (current.hasCompletedOnboarding) return current
      return { ...current, hasCompletedOnboarding: true }
    })

    logEvent('tengu_api_key_login_success', {})
    process.stdout.write(
      `登录成功。\nBASEURL: ${normalizedBaseUrl}\n认证方式: API Key\n`,
    )
    process.exit(0)
  } catch (err) {
    logError(err)
    process.stderr.write(`登录失败: ${errorMessage(err)}\n`)
    process.exit(1)
  }
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const { source: apiKeySource } = getAnthropicApiKeyWithSource()
  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const hasApiKeyEnvVar =
    !!process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()
  const using3P = isUsing3PServices()
  const configuredBaseUrl = getConfiguredApiBaseUrl()
  const resolvedApiKeySource =
    apiKeySource !== 'none'
      ? apiKeySource
      : hasApiKeyEnvVar
        ? 'ANTHROPIC_API_KEY'
        : null
  const resolvedAuthTokenSource =
    hasToken && authTokenSource !== 'apiKeyHelper' ? authTokenSource : null
  const loggedIn =
    using3P || resolvedApiKeySource !== null || resolvedAuthTokenSource !== null

  // Determine auth method
  let authMethod: string = 'none'
  if (using3P) {
    authMethod = 'third_party'
  } else if (resolvedAuthTokenSource !== null) {
    authMethod = 'bearer_token'
  } else if (resolvedApiKeySource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (resolvedApiKeySource !== null) {
    authMethod = 'api_key'
  }

  if (opts.text) {
    process.stdout.write(`登录状态: ${loggedIn ? '已登录' : '未登录'}\n`)
    process.stdout.write(`认证方式: ${authMethod}\n`)
    process.stdout.write(`API 提供方: ${getAPIProvider()}\n`)
    if (resolvedApiKeySource) {
      process.stdout.write(`API Key 来源: ${resolvedApiKeySource}\n`)
    }
    if (resolvedAuthTokenSource) {
      process.stdout.write(`Token 来源: ${resolvedAuthTokenSource}\n`)
    }
    if (configuredBaseUrl) {
      process.stdout.write(`BASEURL: ${configuredBaseUrl}\n`)
    }
    if (!loggedIn) {
      process.stdout.write(
        '未登录。请运行 `sparkc auth login --base-url <BASEURL> --api-key <APIKEY>` 或在交互模式使用 `/login`。\n',
      )
    }
  } else {
    const apiProvider = getAPIProvider()
    const output: Record<string, string | boolean | null> = {
      loggedIn,
      authMethod,
      apiProvider,
      baseUrl: configuredBaseUrl,
    }
    if (resolvedApiKeySource) {
      output.apiKeySource = resolvedApiKeySource
    }
    if (resolvedAuthTokenSource) {
      output.authTokenSource = resolvedAuthTokenSource
    }

    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }
  process.exit(loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  try {
    await performLogout({ clearOnboarding: false })
  } catch {
    process.stderr.write('退出登录失败。\n')
    process.exit(1)
  }
  process.stdout.write('已退出登录，凭证已清除。\n')
  process.exit(0)
}

/**
 * Centralized rate limit message generation
 * Single source of truth for all rate limit-related messages
 */

import {
  getOauthAccountInfo,
  getSubscriptionType,
  isOverageProvisioningAllowed,
} from '../utils/auth.js'
import { hasClaudeAiBillingAccess } from '../utils/billing.js'
import { formatResetTime } from '../utils/format.js'
import type { ClaudeAILimits } from './claudeAiLimits.js'

const FEEDBACK_CHANNEL_ANT = '#briarpatch-cc'

/**
 * All possible rate limit error message prefixes
 * Export this to avoid fragile string matching in UI components
 */
export const RATE_LIMIT_ERROR_PREFIXES = [
  '已达到',
  '你已使用',
  '当前正在使用额外用量',
  '接近',
  '额外用量已用尽',
] as const

/**
 * Check if a message is a rate limit error
 */
export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}

export type RateLimitMessage = {
  message: string
  severity: 'error' | 'warning'
}

/**
 * Get the appropriate rate limit message based on limit state
 * Returns null if no message should be shown
 */
export function getRateLimitMessage(
  limits: ClaudeAILimits,
  model: string,
): RateLimitMessage | null {
  // Check overage scenarios first (when subscription is rejected but overage is available)
  // getUsingOverageText is rendered separately from warning.
  if (limits.isUsingOverage) {
    // Show warning if approaching overage spending limit
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: '你快达到额外用量支出上限了',
        severity: 'warning',
      }
    }
    return null
  }

  // ERROR STATES - when limits are rejected
  if (limits.status === 'rejected') {
    return { message: getLimitReachedText(limits, model), severity: 'error' }
  }

  // WARNING STATES - when approaching limits with early warning
  if (limits.status === 'allowed_warning') {
    // Only show warnings when utilization is above threshold (70%)
    // This prevents false warnings after week reset when API may send
    // allowed_warning with stale data at low usage levels
    const WARNING_THRESHOLD = 0.7
    if (
      limits.utilization !== undefined &&
      limits.utilization < WARNING_THRESHOLD
    ) {
      return null
    }

    // Don't warn non-billing Team/Enterprise users about approaching plan limits
    // if overages are enabled - they'll seamlessly roll into overage
    const subscriptionType = getSubscriptionType()
    const isTeamOrEnterprise =
      subscriptionType === 'team' || subscriptionType === 'enterprise'
    const hasExtraUsageEnabled =
      getOauthAccountInfo()?.hasExtraUsageEnabled === true

    if (
      isTeamOrEnterprise &&
      hasExtraUsageEnabled &&
      !hasClaudeAiBillingAccess()
    ) {
      return null
    }

    const text = getEarlyWarningText(limits)
    if (text) {
      return { message: text, severity: 'warning' }
    }
  }

  // No message needed
  return null
}

/**
 * Get error message for API errors (used in errors.ts)
 * Returns the message string or null if no error message should be shown
 */
export function getRateLimitErrorMessage(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return error messages, not warnings
  if (message && message.severity === 'error') {
    return message.message
  }

  return null
}

/**
 * Get warning message for UI footer
 * Returns the warning message string or null if no warning should be shown
 */
export function getRateLimitWarning(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return warnings for the footer - errors are shown in AssistantTextMessages
  if (message && message.severity === 'warning') {
    return message.message
  }

  // Don't show errors in the footer
  return null
}

function getLimitReachedText(limits: ClaudeAILimits, model: string): string {
  const resetsAt = limits.resetsAt
  const resetTime = resetsAt ? formatResetTime(resetsAt, true) : undefined
  const overageResetTime = limits.overageResetsAt
    ? formatResetTime(limits.overageResetsAt, true)
    : undefined
  const resetMessage = resetTime ? ` · 重置时间 ${resetTime}` : ''

  // if BOTH subscription (checked before this method) and overage are exhausted
  if (limits.overageStatus === 'rejected') {
    // Show the earliest reset time to indicate when user can resume
    let overageResetMessage = ''
    if (resetsAt && limits.overageResetsAt) {
      // Both timestamps present - use the earlier one
      if (resetsAt < limits.overageResetsAt) {
        overageResetMessage = ` · 重置时间 ${resetTime}`
      } else {
        overageResetMessage = ` · 重置时间 ${overageResetTime}`
      }
    } else if (resetTime) {
      overageResetMessage = ` · 重置时间 ${resetTime}`
    } else if (overageResetTime) {
      overageResetMessage = ` · 重置时间 ${overageResetTime}`
    }

    if (limits.overageDisabledReason === 'out_of_credits') {
      return `额外用量已用尽${overageResetMessage}`
    }

    return formatLimitReachedText('用量限制', overageResetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // For pro and enterprise, Sonnet limit is the same as weekly
    const limit = isProOrEnterprise ? '周用量限制' : 'Sonnet 限制'
    return formatLimitReachedText(limit, resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_opus') {
    return formatLimitReachedText('Opus 限制', resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day') {
    return formatLimitReachedText('周用量限制', resetMessage, model)
  }

  if (limits.rateLimitType === 'five_hour') {
    return formatLimitReachedText('会话限制', resetMessage, model)
  }

  return formatLimitReachedText('用量限制', resetMessage, model)
}

function getEarlyWarningText(limits: ClaudeAILimits): string | null {
  let limitName: string | null = null
  switch (limits.rateLimitType) {
    case 'seven_day':
      limitName = '周用量限制'
      break
    case 'five_hour':
      limitName = '会话限制'
      break
    case 'seven_day_opus':
      limitName = 'Opus 限制'
      break
    case 'seven_day_sonnet':
      limitName = 'Sonnet 限制'
      break
    case 'overage':
      limitName = '额外用量'
      break
    case undefined:
      return null
  }

  // utilization and resetsAt should be defined since early warning is calculated with them
  const used = limits.utilization
    ? Math.floor(limits.utilization * 100)
    : undefined
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : undefined

  // Get upsell command based on subscription type and limit type
  const upsell = getWarningUpsellText(limits.rateLimitType)

  if (used && resetTime) {
    const base = `你已使用 ${limitName} 的 ${used}% · 重置时间 ${resetTime}`
    return upsell ? `${base} · ${upsell}` : base
  }

  if (used) {
    const base = `你已使用 ${limitName} 的 ${used}%`
    return upsell ? `${base} · ${upsell}` : base
  }

  if (limits.rateLimitType === 'overage') {
    limitName += '限制'
  }

  if (resetTime) {
    const base = `接近${limitName} · 重置时间 ${resetTime}`
    return upsell ? `${base} · ${upsell}` : base
  }

  const base = `接近${limitName}`
  return upsell ? `${base} · ${upsell}` : base
}

/**
 * Get the upsell command text for warning messages based on subscription and limit type.
 * Returns null if no upsell should be shown.
 * Only used for warnings because actual rate limit hits will see an interactive menu of options.
 */
function getWarningUpsellText(
  rateLimitType: ClaudeAILimits['rateLimitType'],
): string | null {
  const subscriptionType = getSubscriptionType()
  const hasExtraUsageEnabled =
    getOauthAccountInfo()?.hasExtraUsageEnabled === true

  // 5-hour session limit warning
  if (rateLimitType === 'five_hour') {
    // Teams/Enterprise with overages disabled: prompt to request extra usage
    // Only show if overage provisioning is allowed for this org type (e.g., not AWS marketplace)
    if (subscriptionType === 'team' || subscriptionType === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return '使用 /extra-usage 申请更多用量'
      }
      // Teams/Enterprise with overages enabled or unsupported billing type don't need upsell
      return null
    }

    // Pro/Max users: prompt to upgrade
    if (subscriptionType === 'pro' || subscriptionType === 'max') {
      return '使用 /upgrade 继续使用 Spark Code'
    }
  }

  // Overage warning (approaching spending limit)
  if (rateLimitType === 'overage') {
    if (subscriptionType === 'team' || subscriptionType === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return '使用 /extra-usage 申请更多用量'
      }
    }
  }

  // Weekly limit warnings don't show upsell per spec
  return null
}

/**
 * Get notification text for overage mode transitions
 * Used for transient notifications when entering overage mode
 */
export function getUsingOverageText(limits: ClaudeAILimits): string {
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : ''

  let limitName = ''
  if (limits.rateLimitType === 'five_hour') {
    limitName = '会话限制'
  } else if (limits.rateLimitType === 'seven_day') {
    limitName = '周用量限制'
  } else if (limits.rateLimitType === 'seven_day_opus') {
    limitName = 'Opus 限制'
  } else if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // For pro and enterprise, Sonnet limit is the same as weekly
    limitName = isProOrEnterprise ? '周用量限制' : 'Sonnet 限制'
  }

  if (!limitName) {
    return '当前正在使用额外用量'
  }

  const resetMessage = resetTime
    ? ` · ${limitName} 将在 ${resetTime} 重置`
    : ''
  return `当前正在使用额外用量${resetMessage}`
}

function formatLimitReachedText(
  limit: string,
  resetMessage: string,
  _model: string,
): string {
  // Enhanced messaging for Ant users
  if (process.env.USER_TYPE === 'ant') {
    return `已达到${limit}${resetMessage}。如果你对这个限制有反馈，请发到 ${FEEDBACK_CHANNEL_ANT}。可以用 /reset-limits 重置限制`
  }

  return `已达到${limit}${resetMessage}`
}

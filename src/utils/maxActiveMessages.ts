import {
  isValidMaxMessagesCompactionThreshold,
  normalizeMaxMessagesCompactionThreshold,
} from './config.js'

export const DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP = 1000

type MaxActiveMessagesEnv = Record<string, string | undefined>

export function parseMaxActiveMessagesLimit(value: string | undefined): number {
  if (!value) {
    return 0
  }
  const trimmed = value.trim()
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) {
    return 0
  }
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

export function getMaxActiveMessagesHardCap(
  env: MaxActiveMessagesEnv = process.env,
): number {
  const hardCapOverride =
    env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP
  if (hardCapOverride === undefined) {
    return DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP
  }
  const trimmed = hardCapOverride.trim()
  if (trimmed === '0') {
    return 0
  }
  const parsed = parseMaxActiveMessagesLimit(trimmed)
  return parsed > 0 ? parsed : DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP
}

export function resolveMaxActiveMessagesLimit(
  configSetting: string | undefined,
  envSetting: string | undefined,
): number {
  const configuredLimit =
    configSetting !== undefined && configSetting !== 'off'
      ? parseMaxActiveMessagesLimit(configSetting)
      : parseMaxActiveMessagesLimit(envSetting)
  const hardCap = getMaxActiveMessagesHardCap()
  if (configuredLimit > 0 && hardCap > 0) {
    return Math.min(configuredLimit, hardCap)
  }
  return configuredLimit > 0 ? configuredLimit : hardCap
}

export type MessageCountCompactionLimit = {
  // Active-message limit, already combined with the hard cap; 0 means none.
  activeMessageLimit: number
  // An explicit setting or legacy env limit stays active even when
  // auto-compact is disabled.
  hasActiveMessageLimitOverride: boolean
}

export function resolveMessageCountCompactionLimit(
  configuredSetting: unknown,
  legacyEnvSetting: string | undefined,
): MessageCountCompactionLimit {
  // An unset UI setting keeps the legacy environment override. Without that
  // override, enforce the new effective 200-message default.
  const hasValidLegacyActiveMessageLimit =
    parseMaxActiveMessagesLimit(legacyEnvSetting) > 0
  const limitSetting =
    configuredSetting === undefined && hasValidLegacyActiveMessageLimit
      ? undefined
      : normalizeMaxMessagesCompactionThreshold(configuredSetting)
  const hasExplicitMessageCountThreshold =
    configuredSetting !== undefined &&
    isValidMaxMessagesCompactionThreshold(configuredSetting) &&
    configuredSetting !== 'off'
  return {
    activeMessageLimit: resolveMaxActiveMessagesLimit(
      limitSetting,
      legacyEnvSetting,
    ),
    hasActiveMessageLimitOverride:
      hasExplicitMessageCountThreshold ||
      ((configuredSetting === undefined || configuredSetting === 'off') &&
        hasValidLegacyActiveMessageLimit),
  }
}

/**
 * Message count above which the query loop forces compaction, or 0 when the
 * trigger is disabled. With auto-compact disabled, only an explicit limit or
 * the hard cap still applies.
 */
export function getMessageCountCompactionTrigger(
  limit: MessageCountCompactionLimit,
  autoCompactEnabled: boolean,
): number {
  return autoCompactEnabled || limit.hasActiveMessageLimitOverride
    ? limit.activeMessageLimit
    : getMaxActiveMessagesHardCap()
}

export function isAboveMaxActiveMessagesLimit(
  messageCount: number,
  limit = getMaxActiveMessagesHardCap(),
): boolean {
  return limit > 0 && messageCount > limit
}

export function shouldCompactActiveMessageHistory({
  messageCount,
  tokenCount,
  tokenThreshold,
  activeMessageLimit = getMaxActiveMessagesHardCap(),
}: {
  messageCount: number
  tokenCount: number
  tokenThreshold: number
  activeMessageLimit?: number
}): boolean {
  return (
    tokenCount > tokenThreshold ||
    isAboveMaxActiveMessagesLimit(messageCount, activeMessageLimit)
  )
}

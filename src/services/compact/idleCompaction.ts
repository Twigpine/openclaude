import { getUserContext } from '../../context.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import {
  buildPostCompactMessages,
  compactConversation,
} from './compact.js'
import { suppressCompactWarning } from './compactWarningState.js'
import { getCacheSafeParams } from './getCacheSafeParams.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'

// Roughly the delay upstream uses before compacting an idle session.
export const IDLE_COMPACT_DELAY_MS = 54 * 60_000
export const DEFAULT_IDLE_COMPACT_MIN_TOKENS = 200_000
export const IDLE_COMPACT_MIN_TOKENS_ENV =
  'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'

export function getIdleCompactionMinTokens(): number {
  const raw = process.env[IDLE_COMPACT_MIN_TOKENS_ENV]
  if (raw === undefined) return DEFAULT_IDLE_COMPACT_MIN_TOKENS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_IDLE_COMPACT_MIN_TOKENS
  }
  return Math.floor(parsed)
}

export function isIdleCompactionEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  return getGlobalConfig().idleCompaction !== false
}

export function shouldArmIdleCompaction(args: {
  tokenEstimate: number
  compactedAtTokenEstimate: number | null
}): boolean {
  if (!isIdleCompactionEnabled()) return false
  if (args.tokenEstimate < getIdleCompactionMinTokens()) return false
  return args.tokenEstimate !== args.compactedAtTokenEstimate
}

export async function runIdleCompaction(
  messages: readonly Message[],
  context: ToolUseContext,
): Promise<Message[] | null> {
  if (!isIdleCompactionEnabled()) return null
  const compactMessages = getMessagesAfterCompactBoundary([...messages])
  if (compactMessages.length === 0) return null
  const result = await compactConversation(
    compactMessages,
    context,
    await getCacheSafeParams(context, compactMessages),
    false,
    undefined,
    true,
  )
  setLastSummarizedMessageId(undefined)
  suppressCompactWarning()
  getUserContext.cache.clear?.()
  runPostCompactCleanup()
  return buildPostCompactMessages(result)
}

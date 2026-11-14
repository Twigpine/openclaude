import { getUserContext } from '../../context.js'
import { markPostCompaction } from 'src/bootstrap/state.js'
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
import { getCacheSharingParams } from './getCacheSharingParams.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'

// Roughly the delay upstream uses before compacting an idle session.
export const IDLE_COMPACT_DELAY_MS = 54 * 60_000
export const DEFAULT_IDLE_COMPACT_MIN_TOKENS = 200_000
export const IDLE_COMPACT_MIN_TOKENS_ENV =
  'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'

export function getIdleCompactionMinTokens(
  raw: string | undefined = process.env[IDLE_COMPACT_MIN_TOKENS_ENV],
): number {
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
  skipTokenEstimate: number | null
  minTokens?: number
  enabled?: boolean
}): boolean {
  const enabled = args.enabled ?? isIdleCompactionEnabled()
  if (!enabled) return false
  const minTokens = args.minTokens ?? getIdleCompactionMinTokens()
  if (args.tokenEstimate < minTokens) return false
  // A session that was already compacted at this size has no new content to
  // summarize; arming again would compact on every idle window.
  if (
    args.skipTokenEstimate !== null &&
    args.tokenEstimate === args.skipTokenEstimate
  ) {
    return false
  }
  return true
}

/**
 * Runs the standard compaction path for a session that sat idle past
 * IDLE_COMPACT_DELAY_MS. Returns the post-compact message list, or null when
 * compaction is disabled or there is nothing to compact.
 */
export async function runIdleCompaction(
  messages: readonly Message[],
  context: ToolUseContext,
): Promise<{ postCompact: Message[]; preCompactTokenCount?: number } | null> {
  if (!isIdleCompactionEnabled()) return null
  const compactMessages = getMessagesAfterCompactBoundary([...messages])
  if (compactMessages.length === 0) return null
  const result = await compactConversation(
    compactMessages,
    context,
    await getCacheSharingParams(context, compactMessages),
    false,
    undefined,
    true,
  )
  setLastSummarizedMessageId(undefined)
  suppressCompactWarning()
  getUserContext.cache.clear?.()
  markPostCompaction()
  runPostCompactCleanup()
  return {
    postCompact: buildPostCompactMessages(result),
    preCompactTokenCount: result.preCompactTokenCount,
  }
}

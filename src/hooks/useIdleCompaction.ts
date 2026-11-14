import { useEffect, useRef } from 'react'
import {
  IDLE_COMPACT_DELAY_MS,
  isIdleCompactionEnabled,
  shouldArmIdleCompaction,
} from '../services/compact/idleCompaction.js'
import type { Message } from '../types/message.js'
import { logError } from '../utils/log.js'
import { tokenCountWithEstimation } from '../utils/tokens.js'

/**
 * Compacts the conversation after it sits idle for IDLE_COMPACT_DELAY_MS.
 * Arms only when the session is large enough to be worth compacting
 * (CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, default 200k) and the
 * `idleCompaction` setting is not disabled. Any activity (a new turn, which
 * flips isLoading) resets the timer. A session already compacted at its
 * current size is not compacted again until new content arrives.
 *
 * onIdleCompact receives the messages current at fire time and performs the
 * compaction; the caller owns message replacement and the user notice.
 */
export function useIdleCompaction(
  messages: readonly Message[],
  isLoading: boolean,
  onIdleCompact: (messages: readonly Message[]) => Promise<void>,
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const compactedAtEstimateRef = useRef<number | null>(null)
  const messagesRef = useRef(messages)
  const isLoadingRef = useRef(isLoading)
  const onIdleCompactRef = useRef(onIdleCompact)
  messagesRef.current = messages
  isLoadingRef.current = isLoading
  onIdleCompactRef.current = onIdleCompact

  useEffect(() => {
    function clearTimer(): void {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    clearTimer()
    if (isLoading) return clearTimer
    // Check the cheap gates before paying for a token estimate.
    if (!isIdleCompactionEnabled()) return clearTimer
    const tokenEstimate = tokenCountWithEstimation(messagesRef.current)
    if (
      !shouldArmIdleCompaction({
        tokenEstimate,
        compactedAtTokenEstimate: compactedAtEstimateRef.current,
      })
    ) {
      return clearTimer
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (isLoadingRef.current) return
      const firedAtEstimate = tokenCountWithEstimation(messagesRef.current)
      void onIdleCompactRef
        .current(messagesRef.current)
        .then(() => {
          compactedAtEstimateRef.current = firedAtEstimate
        })
        .catch(logError)
    }, IDLE_COMPACT_DELAY_MS)
    return clearTimer
  }, [isLoading])
}

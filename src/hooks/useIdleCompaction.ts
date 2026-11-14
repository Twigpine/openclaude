import { useEffect, useRef } from 'react'
import {
  IDLE_COMPACT_DELAY_MS,
  shouldArmIdleCompaction,
} from '../services/compact/idleCompaction.js'
import type { Message } from '../types/message.js'
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
  const skipTokensRef = useRef<number | null>(null)
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
    const tokenEstimate = tokenCountWithEstimation(messagesRef.current)
    if (
      !shouldArmIdleCompaction({
        tokenEstimate,
        skipTokenEstimate: skipTokensRef.current,
      })
    ) {
      return clearTimer
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (isLoadingRef.current) return
      // Remember the size we fired at so an unchanged session does not
      // compact on every subsequent idle window.
      skipTokensRef.current = tokenCountWithEstimation(messagesRef.current)
      void onIdleCompactRef.current(messagesRef.current)
    }, IDLE_COMPACT_DELAY_MS)
    return clearTimer
  }, [isLoading])
}

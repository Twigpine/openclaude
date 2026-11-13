import type { Message } from '../types/message.js'

function isToolResultMessage(message: Message): boolean {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return (
    Array.isArray(content) &&
    content.some(
      block =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result',
    )
  )
}

/**
 * Did the current turn end in an API error?
 *
 * Reads the transcript rather than the query stream so every session kind
 * counts: local turns mark errors with `isApiErrorMessage`, and remote,
 * direct-connect and SSH turns carry the SDK's `error` field on the assistant
 * message. Walks back from the tail to the last assistant message, skipping
 * the system messages a turn appends after an error (duration, cache stats).
 * Stops at the user prompt that opened the turn, so an earlier turn's error
 * never leaks into a turn that produced no reply.
 */
export function lastTurnFailed(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type === 'assistant') {
      return message.isApiErrorMessage === true || message.error !== undefined
    }
    if (message.type === 'user' && message.isMeta !== true && !isToolResultMessage(message)) {
      return false
    }
  }
  return false
}

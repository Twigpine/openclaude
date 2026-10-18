/**
 * Guard against "[Tool results received]" marker echoes (issue #2039).
 *
 * The OpenAI shim used to inject a synthetic assistant message containing
 * "[Tool results received]" whenever tool results were followed by a user
 * message. Models reproduced that marker verbatim as their reply with
 * finish_reason "stop", ending the agent loop mid-task. The insertion was
 * removed from convertMessages, but two residual paths remain:
 *
 *   1. Legacy session histories already contain marker assistant messages.
 *      They must never be re-sent to providers or echoed back to the agent.
 *   2. Models may still echo markers copied into history by older versions.
 *
 * Two layers:
 *
 *   - `stripEchoedToolResultsMarker()` — whole-text cleanup for complete
 *     responses (non-streaming conversion) and request-side assistant
 *     history.
 *   - `stripMarkerEchoesFromStream()` — Anthropic stream-event wrapper that
 *     applies the same cleanup per text content block before events reach
 *     the agent loop, holding back only a trailing partial-marker prefix so
 *     markers split across SSE deltas are still recognized.
 */

export const TOOL_RESULTS_RECEIVED_MARKER = '[Tool results received]'

const MAX_PARTIAL_MARKER = TOOL_RESULTS_RECEIVED_MARKER.length - 1

/** Remove every literal occurrence of the shim's tool-results marker. */
export function stripEchoedToolResultsMarker(text: string): string {
  if (!text || !text.includes(TOOL_RESULTS_RECEIVED_MARKER)) return text
  return text.split(TOOL_RESULTS_RECEIVED_MARKER).join('')
}

function longestPartialMarkerSuffix(text: string): number {
  const max = Math.min(MAX_PARTIAL_MARKER, text.length)
  for (let len = max; len > 0; len--) {
    if (TOOL_RESULTS_RECEIVED_MARKER.startsWith(text.slice(text.length - len))) {
      return len
    }
  }
  return 0
}

type StreamEventLike = {
  type?: unknown
  index?: unknown
  content_block?: Record<string, unknown> | null
  delta?: Record<string, unknown> | null
}

/**
 * Wrap an Anthropic-format event stream so literal marker echoes are stripped
 * from text content blocks before they reach the agent loop. All non-text
 * events pass through untouched. Text held back as a possible partial marker
 * is released when its content block closes.
 */
export async function* stripMarkerEchoesFromStream<T extends StreamEventLike>(
  events: AsyncGenerator<T>,
): AsyncGenerator<T> {
  const accumulated = new Map<number, string>()
  const forwardedLengths = new Map<number, number>()

  for await (const event of events) {
    switch (event.type) {
      case 'content_block_start': {
        const index = typeof event.index === 'number' ? event.index : 0
        if (event.content_block?.type === 'text') {
          accumulated.set(index, '')
          forwardedLengths.set(index, 0)
        }
        yield event
        break
      }
      case 'content_block_delta': {
        const delta = event.delta as { type?: unknown; text?: unknown } | null
        const index = typeof event.index === 'number' ? event.index : 0
        if (
          delta?.type !== 'text_delta' ||
          typeof delta.text !== 'string' ||
          !delta.text ||
          !accumulated.has(index)
        ) {
          yield event
          break
        }
        const acc = accumulated.get(index)! + delta.text
        accumulated.set(index, acc)
        const clean = stripEchoedToolResultsMarker(acc)
        // Hold back a trailing partial marker until the next delta resolves it.
        const holdLen = longestPartialMarkerSuffix(clean)
        const emitLength = clean.length - holdLen
        const forwarded = forwardedLengths.get(index) ?? 0
        if (emitLength > forwarded) {
          forwardedLengths.set(index, emitLength)
          yield {
            ...event,
            delta: { type: 'text_delta', text: clean.slice(forwarded, emitLength) },
          } as unknown as T
        }
        break
      }
      case 'content_block_stop': {
        const index = typeof event.index === 'number' ? event.index : 0
        if (accumulated.has(index)) {
          const clean = stripEchoedToolResultsMarker(accumulated.get(index)!)
          const forwarded = forwardedLengths.get(index) ?? 0
          if (clean.length > forwarded) {
            forwardedLengths.set(index, clean.length)
            yield {
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: clean.slice(forwarded) },
            } as unknown as T
          }
          accumulated.delete(index)
          forwardedLengths.delete(index)
        }
        yield event
        break
      }
      default:
        yield event
    }
  }
}

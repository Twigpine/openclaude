import { describe, expect, test } from 'bun:test'
import type { Message, UserMessage } from '../../types/message.js'
import { isToolResultMessage, isTurnStart, MIN_COLLAPSE_TOKENS, selectCollapseSpan, computeRisk } from './spanSelection.js'

function userMsg(content: UserMessage["message"]["content"] = 'hi', extra: Record<string, unknown> = {}): Message {
  return { type: 'user', uuid: 'u', timestamp: '', message: { role: 'user', content }, ...extra } as unknown as Message
}
function assistantMsg(): Message {
  return { type: 'assistant', uuid: 'a', timestamp: '', message: { role: 'assistant', content: 'ok' } } as unknown as Message
}

describe('isToolResultMessage', () => {
  test('true for user message with a tool_result block', () => {
    expect(isToolResultMessage(userMsg([{ type: 'tool_result', tool_use_id: 'x', content: 'r' }]))).toBe(true)
  })
  test('false for plain user text', () => {
    expect(isToolResultMessage(userMsg('hello'))).toBe(false)
  })
  test('false for assistant message', () => {
    expect(isToolResultMessage(assistantMsg())).toBe(false)
  })
})

describe('isTurnStart', () => {
  test('true for a plain user message', () => {
    expect(isTurnStart(userMsg('hello'))).toBe(true)
  })
  test('false for a tool_result user message', () => {
    expect(isTurnStart(userMsg([{ type: 'tool_result', tool_use_id: 'x', content: 'r' }]))).toBe(false)
  })
  test('false for a meta user message', () => {
    expect(isTurnStart(userMsg('hello', { isMeta: true }))).toBe(false)
  })
  test('false for an assistant message', () => {
    expect(isTurnStart(assistantMsg())).toBe(false)
  })
})

// Build an alternating user/assistant transcript with stable uuids.
function transcript(n: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    const isUser = i % 2 === 0
    out.push({
      type: isUser ? 'user' : 'assistant',
      uuid: `m${i}`,
      timestamp: '',
      message: { role: isUser ? 'user' : 'assistant', content: isUser ? `q${i}` : `a${i}` },
    } as unknown as Message)
  }
  return out
}

// Fake estimator: every message counts as 100 tokens. Deterministic + easy to reason about.
const flat100 = (msgs: Message[]) => msgs.length * 100

describe('selectCollapseSpan', () => {
  test('returns null when there is no collapsible region', () => {
    // 4 messages, window 1000: protected tail 30% = 300 => protects last 3; head protects m0.
    expect(selectCollapseSpan(transcript(4), 1000, flat100)).toBeNull()
  })

  test('selects an oldest span anchored on turn boundaries', () => {
    // 40 messages * 100 = 4000 tokens. window 1000.
    // protected tail = 300 tokens => last 3 msgs protected (tail starts ~m37, snapped to a turn-start).
    // head protects m0. candidate starts at the next turn-start (m2).
    const span = selectCollapseSpan(transcript(40), 1000, flat100)
    expect(span).not.toBeNull()
    expect(span!.startUuid).toBe('m2')
    expect(span!.startIndex).toBe(2)
    expect(span!.tokenEstimate).toBeGreaterThanOrEqual(MIN_COLLAPSE_TOKENS)
  })

  test('returns null when the candidate span is below MIN_COLLAPSE_TOKENS', () => {
    // 8 messages * 100 = 800 tokens total; any candidate span is well under 2000.
    expect(selectCollapseSpan(transcript(8), 1000, flat100)).toBeNull()
  })

  test('span ends on a turn boundary (never mid-turn)', () => {
    const msgs = transcript(40)
    const span = selectCollapseSpan(msgs, 1000, flat100)
    expect(span).not.toBeNull()
    const endIdx = msgs.findIndex(m => (m.uuid as string) === span!.endUuid)
    expect(endIdx).toBeGreaterThanOrEqual(0)
    // The message immediately after the span must begin a new turn (or the span
    // ends at the last message) — proving the span never cuts mid-turn.
    const endsOnBoundary = endIdx === msgs.length - 1 || isTurnStart(msgs[endIdx + 1]!)
    expect(endsOnBoundary).toBe(true)
  })
})

describe('computeRisk', () => {
  test('older span (lower startIndex) scores higher than newer', () => {
    const older = computeRisk(0, 100, 1000, 10000)
    const newer = computeRisk(80, 100, 1000, 10000)
    expect(older).toBeGreaterThan(newer)
  })
  test('bigger span scores higher than smaller', () => {
    const big = computeRisk(10, 100, 5000, 10000)
    const small = computeRisk(10, 100, 500, 10000)
    expect(big).toBeGreaterThan(small)
  })
  test('always clamped to [0,1]', () => {
    expect(computeRisk(0, 100, 999999, 10000)).toBeLessThanOrEqual(1)
    expect(computeRisk(100, 100, 0, 10000)).toBeGreaterThanOrEqual(0)
  })
})

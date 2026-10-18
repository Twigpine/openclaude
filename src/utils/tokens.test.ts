import { describe, expect, it } from 'bun:test'
import {
  roughTokenCountEstimationForMessage,
  roughTokenCountEstimationForMessages,
} from '../services/tokenEstimation.js'
import { getCurrentUsage, getUnreportedSessionUsage } from './tokens.js'
import { IncrementalTokenCounter } from './incrementalTokenCounter.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { createCompactBoundaryMessage } from './messages/systemFactories.js'

interface FakeUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

describe('tokens', () => {
  const assistantMessage = (
    usage: FakeUsage,
    content = 'assistant response',
    id = 'msg_1',
  ): AssistantMessage =>
    ({
      type: 'assistant',
      uuid: '00000000-0000-0000-0000-000000000001',
      timestamp: '2026-06-28T00:00:00.000Z',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'mimo-v2.5-pro',
        content: [{ type: 'text', text: content }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage,
      },
    }) as unknown as AssistantMessage

  const userMessage = (content: string): Message =>
    ({
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000002',
      timestamp: '2026-06-28T00:00:00.000Z',
      message: {
        role: 'user',
        content,
      },
    }) as Message

  it('returns reported API usage for non-zero assistant usage', () => {
    expect(
      getCurrentUsage([
        userMessage('hello'),
        assistantMessage({
          input_tokens: 120,
          output_tokens: 30,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        }),
      ]),
    ).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    })
  })

  it('does not report pre-compact usage before the next assistant response', () => {
    const archived = assistantMessage({ input_tokens: 90000, output_tokens: 500 })
    const boundary = createCompactBoundaryMessage('manual', 90500)
    const summary = userMessage('Compacted conversation summary.')

    expect(getCurrentUsage([archived, boundary, summary])).toBeNull()
  })

  it('estimates only the active context after compaction for all-zero usage', () => {
    const archived = userMessage('Archived context. '.repeat(1000))
    const boundary = createCompactBoundaryMessage('manual', 90000)
    const summary = userMessage('Compacted conversation summary.')
    const prompt = userMessage('Continue from the summary.')
    const reply = assistantMessage({ input_tokens: 0, output_tokens: 0 })
    const activeMessages = [boundary, summary, prompt, reply]

    expect(getCurrentUsage([archived, ...activeMessages])).toEqual(
      getCurrentUsage(activeMessages),
    )
    expect(getCurrentUsage(activeMessages)?.input_tokens).toBe(
      roughTokenCountEstimationForMessages([summary, prompt]),
    )
  })

  it('uses the latest compact boundary after repeated compaction', () => {
    const firstBoundary = createCompactBoundaryMessage('manual', 90000)
    const oldSummary = userMessage('Previous summary. '.repeat(1000))
    const oldReply = assistantMessage({ input_tokens: 0, output_tokens: 0 }, 'Old reply.', 'old')
    const latestBoundary = createCompactBoundaryMessage('auto', 50000)
    const summary = userMessage('Latest summary.')
    const reply = assistantMessage({ input_tokens: 0, output_tokens: 0 }, 'Latest reply.', 'latest')
    const activeMessages = [latestBoundary, summary, reply]

    expect(getCurrentUsage([firstBoundary, oldSummary, oldReply, ...activeMessages])).toEqual(
      getCurrentUsage(activeMessages),
    )
  })

  it('preserves reported usage after compaction', () => {
    const archived = assistantMessage({ input_tokens: 90000, output_tokens: 500 }, 'Archived.', 'old')
    const boundary = createCompactBoundaryMessage('manual', 90500)
    const summary = userMessage('Summary.')
    const reply = assistantMessage({ input_tokens: 800, output_tokens: 30, cache_read_input_tokens: 200 }, 'Fresh.', 'fresh')

    expect(getCurrentUsage([archived, boundary, summary, reply])).toEqual({
      input_tokens: 800,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 200,
    })
  })

  it('estimates current context when the latest provider usage is all zero', () => {
    const prompt = userMessage('Please summarize this repository structure.')
    const reply = assistantMessage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      'The repository contains source files and tests.',
    )
    const usage = getCurrentUsage([prompt, reply])

    expect(usage).toEqual({
      input_tokens: Math.max(1, roughTokenCountEstimationForMessages([prompt])),
      output_tokens: Math.max(1, roughTokenCountEstimationForMessage(reply)),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      is_estimated: true,
    })
  })

  it('does not fall back to stale older API usage after all-zero provider usage', () => {
    const older = assistantMessage(
      {
        input_tokens: 5000,
        output_tokens: 250,
      },
      'Older Anthropic response.',
      'msg_reported',
    )
    const prompt = userMessage('Now use a provider that does not report usage.')
    const latest = assistantMessage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      'Latest response from unsupported usage provider.',
      'msg_unsupported',
    )
    const usage = getCurrentUsage([older, prompt, latest])

    expect(usage).toEqual({
      input_tokens: Math.max(
        1,
        roughTokenCountEstimationForMessages([older, prompt]),
      ),
      output_tokens: Math.max(1, roughTokenCountEstimationForMessage(latest)),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      is_estimated: true,
    })
  })

  it('estimates split assistant response siblings as output tokens', () => {
    const prompt = userMessage('Please run a tool and summarize the result.')
    const firstChunk = assistantMessage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      'First split response chunk with substantial text explaining the result.',
      'msg_split',
    )
    const lastChunk = assistantMessage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      'Final chunk.',
      'msg_split',
    )

    const messages = [prompt, firstChunk, userMessage('tool result payload'), lastChunk]
    const usage = getCurrentUsage(messages)
    const expectedInputTokens = Math.max(
      1,
      roughTokenCountEstimationForMessages([prompt]),
    )
    const expectedOutputTokens = Math.max(
      1,
      roughTokenCountEstimationForMessage(firstChunk) +
        roughTokenCountEstimationForMessage(lastChunk),
    )

    expect(usage?.is_estimated).toBe(true)
    expect(usage?.input_tokens).toBe(expectedInputTokens)
    expect(usage?.output_tokens).toBe(expectedOutputTokens)
    expect(getUnreportedSessionUsage(messages)).toMatchObject({
      input_tokens: expectedInputTokens,
      output_tokens: expectedOutputTokens,
    })
  })

  it('estimates cumulative unreported session usage from all-zero responses', () => {
    const firstUser = userMessage('First user request.')
    const firstAssistant = assistantMessage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      'First unsupported provider response.',
      'msg_first',
    )
    const secondUser = userMessage('Second user request.')
    const secondAssistant = assistantMessage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      'Second unsupported provider response.',
      'msg_second',
    )

    const messages = [firstUser, firstAssistant, secondUser, secondAssistant]

    expect(getUnreportedSessionUsage(messages)).toEqual({
      input_tokens:
        Math.max(1, roughTokenCountEstimationForMessages([firstUser])) +
        Math.max(
          1,
          roughTokenCountEstimationForMessages([
            firstUser,
            firstAssistant,
            secondUser,
          ]),
        ),
      output_tokens:
        Math.max(1, roughTokenCountEstimationForMessage(firstAssistant)) +
        Math.max(1, roughTokenCountEstimationForMessage(secondAssistant)),
    })
  })
})

describe('IncrementalTokenCounter', () => {
  it('uses cached count for same message length', () => {
    const counter = new IncrementalTokenCounter()
    
    counter.getCount([
      { type: 'user', message: { content: 'hello' } } as any,
    ])
    
    expect(counter.cachedCount).toBeGreaterThan(0)
  })

  it('increments for new messages', () => {
    const counter = new IncrementalTokenCounter()
    
    const count1 = counter.getCount([
      { type: 'user', message: { content: 'hello' } } as any,
    ])
    
    const count2 = counter.getCount([
      { type: 'user', message: { content: 'hello' } } as any,
      { type: 'user', message: { content: 'world' } } as any,
    ])
    
    expect(count2).toBeGreaterThan(count1)
  })

  it('resets correctly', () => {
    const counter = new IncrementalTokenCounter()
    
    counter.getCount([{ type: 'user', message: { content: 'hello' } } as any])
    counter.reset()
    
    expect(counter.cachedCount).toBe(0)
    expect(counter.messageCount).toBe(0)
  })
})

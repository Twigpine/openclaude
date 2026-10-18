import { beforeEach, describe, expect, it } from 'bun:test'
import { resetStateForTests } from '../cost-tracker.js'
import { getUnreportedSessionUsage } from '../utils/tokens.js'
import { createCompactBoundaryMessage } from '../utils/messages/systemFactories.js'
import {
  buildStatusLineCommandInput,
  getLastAssistantMessageId,
  resolveStatusLineUpdateAction,
  resolveStatusLineTokenTotals,
} from './StatusLine.js'
import type { AssistantMessage, Message } from '../types/message.js'

;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test-version',
}

const assistantMessage = (
  content: string,
  id = 'msg_unsupported',
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
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
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

describe('getLastAssistantMessageId', () => {
  it('invalidates the status line at compaction before a new response arrives', () => {
    const archived = assistantMessage('Archived response.')
    const boundary = createCompactBoundaryMessage('manual', 90000)
    const summary = userMessage('Compacted summary.')

    expect(getLastAssistantMessageId([archived])).toBe(archived.uuid)
    expect(getLastAssistantMessageId([archived, boundary, summary])).toBeNull()

    const reply: AssistantMessage = {
      ...assistantMessage('Fresh response.'),
      uuid: '00000000-0000-0000-0000-000000000003',
    }
    expect(getLastAssistantMessageId([archived, boundary, summary, reply])).toBe(reply.uuid)
  })
})

describe('resolveStatusLineTokenTotals', () => {
  it('keeps reported usage totals unchanged', () => {
    expect(resolveStatusLineTokenTotals(1200, 300, null)).toEqual({
      totalInputTokens: 1200,
      totalOutputTokens: 300,
      totalTokensAreEstimated: undefined,
    })
  })

  it('adds unreported session usage to cumulative session totals', () => {
    expect(
      resolveStatusLineTokenTotals(1200, 300, {
        input_tokens: 90,
        output_tokens: 20,
      }),
    ).toEqual({
      totalInputTokens: 1290,
      totalOutputTokens: 320,
      totalTokensAreEstimated: true,
    })
  })
})

describe('resolveStatusLineUpdateAction', () => {
  it('cancels pending work and records a refresh when hidden', () => {
    expect(resolveStatusLineUpdateAction({ active: false, hasRun: true, needsRefresh: false, stateChanged: false, commandChanged: false, hasPendingUpdate: true })).toEqual({ action: 'cancel', needsRefresh: true })
  })

  it('runs once when first activated with pending changes', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: false, needsRefresh: true, stateChanged: true, commandChanged: false, hasPendingUpdate: false })).toEqual({ action: 'run' })
  })

  it('runs immediately when reactivated after hidden changes', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: true, needsRefresh: true, stateChanged: false, commandChanged: false, hasPendingUpdate: false })).toEqual({ action: 'run' })
  })

  it('debounces ordinary visible state changes', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: true, needsRefresh: false, stateChanged: true, commandChanged: false, hasPendingUpdate: false })).toEqual({ action: 'schedule' })
  })

  it('does nothing when active and nothing changed', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: true, needsRefresh: false, stateChanged: false, commandChanged: false, hasPendingUpdate: false })).toEqual({ action: 'none' })
  })

  it('runs immediately when the statusline command changes', () => {
    expect(resolveStatusLineUpdateAction({ active: true, hasRun: true, needsRefresh: false, stateChanged: false, commandChanged: true, hasPendingUpdate: false })).toEqual({ action: 'run' })
  })
})

describe('buildStatusLineCommandInput', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  it('emits estimated cumulative totals for unreported provider usage', () => {
    const messages = [
      userMessage('Please summarize this repository.'),
      assistantMessage('This repository contains source files and tests.'),
    ]
    const unreportedUsage = getUnreportedSessionUsage(messages)
    expect(unreportedUsage).not.toBeNull()

    const input = buildStatusLineCommandInput(
      'default',
      false,
      {},
      messages,
      [],
      'mimo-v2.5-pro',
    )

    expect(input.context_window).toMatchObject({
      total_input_tokens: unreportedUsage!.input_tokens,
      total_output_tokens: unreportedUsage!.output_tokens,
      total_tokens_are_estimated: true,
      current_usage: {
        is_estimated: true,
      },
    })
  })
})

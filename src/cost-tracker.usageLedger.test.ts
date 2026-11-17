/**
 * Verifies that `addToTotalSessionCost` feeds the local usage ledger used by
 * `/usage`: real requests (which pass a recording context) are recorded,
 * replays without a context are not, and advisor iterations are recorded
 * as their own requests.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { addToTotalSessionCost, resetCostState } from './cost-tracker.js'
import {
  getRecordedUsageEvents,
  resetUsageLedgerForTesting,
} from './services/usage/ledger.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from './test/sharedMutationLock.js'

type Usage = Parameters<typeof addToTotalSessionCost>[1]

function usage(input: number, output: number, extra: object = {}): Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...extra,
  } as Usage
}

beforeEach(async () => {
  await acquireSharedMutationLock('cost-tracker.usageLedger.test.ts')
  resetCostState()
  resetUsageLedgerForTesting()
})

afterEach(() => {
  try {
    resetCostState()
    resetUsageLedgerForTesting()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('addToTotalSessionCost → usage ledger', () => {
  test('records a request made with a recording context', () => {
    // Same shape claude.ts passes for a per-agent provider override.
    const providerOverride = {
      model: 'm',
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'unused',
    }
    addToTotalSessionCost(0.01, usage(200, 50), 'claude-sonnet-4-6', {
      querySource: 'agent:builtin:Explore',
      agentId: 'agent-7',
      providerOverride,
    })

    const events = getRecordedUsageEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      source: 'agent:builtin:Explore',
      agentId: 'agent-7',
      route: 'ollama',
      local: true,
      input: 200,
      output: 50,
    })
    expect(JSON.stringify(events[0])).not.toContain('unused')
  })

  test('does not record calls without a context, such as replays', () => {
    addToTotalSessionCost(0.01, usage(200, 50), 'claude-sonnet-4-6')
    expect(getRecordedUsageEvents()).toHaveLength(0)
  })

  test('repeated stream reports for one request stay one event, advisor included', () => {
    const withAdvisor = (output: number) =>
      usage(100, output, {
        iterations: [
          {
            type: 'advisor_message',
            model: 'claude-opus-4-8',
            input_tokens: 3000,
            output_tokens: 400,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      })
    const context = { querySource: 'repl_main_thread', requestKey: 'stream-1' }
    addToTotalSessionCost(0, withAdvisor(0), 'claude-sonnet-4-6', context)
    addToTotalSessionCost(0.01, withAdvisor(20), 'claude-sonnet-4-6', context)

    expect(
      getRecordedUsageEvents().map(event => [event.source, event.output]),
    ).toEqual([
      ['repl_main_thread', 20],
      ['advisor', 400],
    ])
  })

  test('records advisor iterations as separate advisor requests', () => {
    addToTotalSessionCost(
      0.01,
      usage(100, 20, {
        iterations: [
          {
            type: 'advisor_message',
            model: 'claude-opus-4-8',
            input_tokens: 3000,
            output_tokens: 400,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      }),
      'claude-sonnet-4-6',
      { querySource: 'repl_main_thread' },
    )

    expect(
      getRecordedUsageEvents().map(event => [
        event.model,
        event.source,
        event.input,
      ]),
    ).toEqual([
      ['claude-sonnet-4-6', 'repl_main_thread', 100],
      ['claude-opus-4-8', 'advisor', 3000],
    ])
  })
})

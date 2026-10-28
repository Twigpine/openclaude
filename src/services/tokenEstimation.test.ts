import type { Anthropic } from '@anthropic-ai/sdk'
import { expect, mock, test } from 'bun:test'
import { jsonStringify } from '../utils/slowOperations.js'
import { __test, roughTokenCountEstimation, roughTokenCountEstimationForMessage } from './tokenEstimation.js'

test('rough estimation handles browser state alongside text, images and tool references in tool results', () => {
  const browserState: Anthropic.BrowserStateBlockParam = { type: 'browser_state', tabs: [] }
  const reference: Anthropic.ToolReferenceBlockParam = { type: 'tool_reference', tool_name: 'lookup_docs' }
  const toolResult: Anthropic.ToolResultBlockParam = {
    type: 'tool_result', tool_use_id: 'tool_browser',
    content: [
      { type: 'text', text: 'page loaded' }, browserState, reference,
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(10000) } },
    ],
  }
  expect(roughTokenCountEstimationForMessage({
    type: 'user', message: { content: [toolResult] },
  })).toBe(
    roughTokenCountEstimation('page loaded') +
    roughTokenCountEstimation(jsonStringify(browserState)) +
    roughTokenCountEstimation(jsonStringify(reference)) + 2000,
  )
})

function createTextTool(): Anthropic.Beta.Messages.BetaToolUnion {
  return {
    name: 'lookup_docs',
    description: 'Look up project documentation.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  }
}

test('countMessagesTokensWithClient falls back when shim client lacks countTokens', async () => {
  const content = 'hello from an openai-compatible provider'

  const result = await __test.countMessagesTokensWithClient({
    messagesClient: {},
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    tools: [],
    filteredBetas: [],
    containsThinking: false,
  })

  expect(result).toBe(roughTokenCountEstimation(content))
})

test('countMessagesTokensWithClient includes tool overhead in fallback estimates', async () => {
  const content = 'count this request with tool definitions'
  const tools = [createTextTool()]

  const result = await __test.countMessagesTokensWithClient({
    messagesClient: {},
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    tools,
    filteredBetas: [],
    containsThinking: false,
  })

  expect(result).toBe(
    roughTokenCountEstimation(content) +
      500 +
      roughTokenCountEstimation(jsonStringify(tools)),
  )
})

test('countMessagesTokensWithClient uses countTokens when the client supports it', async () => {
  const countTokens = mock(async (_params: unknown) => ({ input_tokens: 42 }))
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: 'user', content: 'use exact count when available' },
  ]

  const result = await __test.countMessagesTokensWithClient({
    messagesClient: {
      countTokens:
        countTokens as unknown as Anthropic['beta']['messages']['countTokens'],
    },
    model: 'gpt-4o',
    messages,
    tools: [],
    filteredBetas: [],
    containsThinking: false,
  })

  expect(countTokens).toHaveBeenCalledTimes(1)
  expect(countTokens.mock.calls[0]?.[0]).toEqual({
    model: 'gpt-4o',
    messages,
    tools: [],
  })
  expect(result).toBe(42)
})

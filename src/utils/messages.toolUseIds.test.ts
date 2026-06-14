import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as providersModule from './model/providers.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from './messages.js'
import type { Message } from '../types/message.js'
import type { LegacyAPIProvider } from './model/providers.js'

// normalizeMessagesForAPI decides whether to sanitize tool ids from
// getAPIProvider(). That reads global env/route state which other tests in the
// full suite mutate (mock.module on providers, leaked flags, etc.), so we mock
// the provider directly to make these assertions hermetic and order-independent.
function mockApiProvider(provider: LegacyAPIProvider): void {
  mock.module('./model/providers.js', () => ({
    ...providersModule,
    getAPIProvider: () => provider,
  }))
}

function restoreApiProvider(): void {
  mock.module('./model/providers.js', () => ({ ...providersModule }))
}

const SIGNED_ID = `toolu_vertex_k9x_3~~sig~~${'S'.repeat(1700)}`

function buildHistory(): Message[] {
  return [
    createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: SIGNED_ID,
          name: 'Read',
          input: { file_path: '/tmp/x' },
        } as never,
      ],
    }),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: SIGNED_ID,
          content: 'done',
        } as never,
      ],
    }),
  ]
}

function extractIds(normalized: ReturnType<typeof normalizeMessagesForAPI>): {
  toolUseId: string | undefined
  toolResultId: string | undefined
} {
  let toolUseId: string | undefined
  let toolResultId: string | undefined
  for (const msg of normalized) {
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    for (const block of content as unknown as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') toolUseId = block.id as string
      if (block.type === 'tool_result') toolResultId = block.tool_use_id as string
    }
  }
  return { toolUseId, toolResultId }
}

describe('normalizeMessagesForAPI Vertex tool_use id sanitation', () => {
  afterEach(restoreApiProvider)

  test('strips smuggled thought signatures when the wire is not Gemini Vertex', () => {
    mockApiProvider('openai')

    const { toolUseId, toolResultId } = extractIds(
      normalizeMessagesForAPI(buildHistory()),
    )

    expect(toolUseId).toBeDefined()
    expect(toolUseId!.length).toBeLessThanOrEqual(64)
    expect(toolUseId).toMatch(/^[A-Za-z0-9_-]+$/)
    // call/result pairing must survive the rewrite
    expect(toolResultId).toBe(toolUseId)
  })

  test('preserves signed ids when the wire is Gemini Vertex', () => {
    mockApiProvider('gemini-vertex')

    const { toolUseId, toolResultId } = extractIds(
      normalizeMessagesForAPI(buildHistory()),
    )

    expect(toolUseId).toBe(SIGNED_ID)
    expect(toolResultId).toBe(SIGNED_ID)
  })
})

import { snapshotEnv } from '../test/envSnapshot.js'
import { PROVIDER_SELECTION_FLAGS } from './providerSelectionFlags.js'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from './messages.js'
import type { Message } from '../types/message.js'

const SIGNED_ID = `toolu_vertex_k9x_3~~sig~~${'S'.repeat(1700)}`

function buildHistory(id = SIGNED_ID): Message[] {
  return [
    createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Read',
          input: { file_path: '/tmp/x' },
        } as never,
      ],
    }),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
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
  let restoreEnv: () => void
  beforeEach(() => {
    restoreEnv = snapshotEnv([...PROVIDER_SELECTION_FLAGS, 'OPENAI_MODEL', 'OPENAI_BASE_URL', 'GEMINI_VERTEX_MODEL'], { clear: true })
  })
  afterEach(() => restoreEnv())

  test('strips smuggled thought signatures when the wire is not Gemini Vertex', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-4o'

    const { toolUseId, toolResultId } = extractIds(
      normalizeMessagesForAPI(buildHistory()),
    )

    expect(toolUseId).toBeDefined()
    expect(toolUseId!.length).toBeLessThanOrEqual(64)
    expect(toolUseId).toMatch(/^[A-Za-z0-9_-]+$/)
    // call/result pairing must survive the rewrite
    expect(toolResultId).toBe(toolUseId)
  })

  test('keeps opaque string IDs distinct and paired without rewriting stored history', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const ids = ['call.one', 'call.two']
    const history = ids.flatMap(id => buildHistory(id))
    const before = JSON.stringify(history)
    const normalized = normalizeMessagesForAPI(history)
    const calls = normalized.filter(msg => msg.type === 'assistant').map(msg => extractIds([msg]).toolUseId)
    const results = normalized.filter(msg => msg.type === 'user').map(msg => extractIds([msg]).toolResultId)
    expect(calls).toHaveLength(2)
    expect(new Set(calls).size).toBe(2)
    expect(results).toEqual(calls)
    expect(JSON.stringify(history)).toBe(before)
  })

  test('preserves signed ids when the wire is Gemini Vertex', () => {
    process.env.CLAUDE_CODE_USE_GEMINI_VERTEX = '1'
    process.env.GEMINI_VERTEX_MODEL = 'gemini-2.5-flash'

    const { toolUseId, toolResultId } = extractIds(
      normalizeMessagesForAPI(buildHistory()),
    )

    expect(toolUseId).toBe(SIGNED_ID)
    expect(toolResultId).toBe(SIGNED_ID)
  })
})

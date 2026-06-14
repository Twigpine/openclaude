import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from './messages.js'
import { PROVIDER_SELECTION_FLAGS } from './providerSelectionFlags.js'
import type { Message } from '../types/message.js'

// getAPIProvider() inspects every CLAUDE_CODE_USE_* flag (e.g. FOUNDRY is
// checked before route resolution), so a flag leaked by an earlier test in
// the full suite would flip the wire and make these assertions order-dependent.
// Clear the whole provider-selection registry before each test.
const VERTEX_VARS = [
  'GEMINI_VERTEX_MODEL',
  'GEMINI_VERTEX_PROJECT',
  'GEMINI_VERTEX_LOCATION',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
] as const

function clearProviderEnv(): void {
  for (const flag of PROVIDER_SELECTION_FLAGS) delete process.env[flag]
  for (const v of VERTEX_VARS) delete process.env[v]
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
  beforeEach(clearProviderEnv)
  afterEach(clearProviderEnv)

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

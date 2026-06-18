import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as providerProfilesModule from './providerProfiles.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from './messages.js'
import type { Message } from '../types/message.js'

// normalizeMessagesForAPI sanitizes Vertex tool ids based on the *effective*
// provider (env flag OR saved active profile) via isGeminiVertexEffectiveProvider.
// That reads global env/route + config state which other tests in the full suite
// mutate, so mock the decision directly to make these assertions hermetic and
// order-independent. Passing `true` exercises both the env-flag and the
// saved-profile-only Vertex routes (the helper unifies them).
function mockGeminiVertexEffective(isVertex: boolean): void {
  mock.module('./providerProfiles.js', () => ({
    ...providerProfilesModule,
    isGeminiVertexEffectiveProvider: () => isVertex,
  }))
}

function restoreGeminiVertexEffective(): void {
  mock.module('./providerProfiles.js', () => ({ ...providerProfilesModule }))
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
  afterEach(restoreGeminiVertexEffective)

  test('strips smuggled thought signatures when the wire is not Gemini Vertex', () => {
    mockGeminiVertexEffective(false)

    const { toolUseId, toolResultId } = extractIds(
      normalizeMessagesForAPI(buildHistory()),
    )

    expect(toolUseId).toBeDefined()
    expect(toolUseId!.length).toBeLessThanOrEqual(64)
    expect(toolUseId).toMatch(/^[A-Za-z0-9_-]+$/)
    // call/result pairing must survive the rewrite
    expect(toolResultId).toBe(toolUseId)
  })

  test('preserves signed ids when Gemini Vertex is the effective provider (env flag or saved profile)', () => {
    // true covers both routes; isGeminiVertexEffectiveProvider returns true for
    // the saved-profile-only path even when CLAUDE_CODE_USE_GEMINI_VERTEX is unset.
    mockGeminiVertexEffective(true)

    const { toolUseId, toolResultId } = extractIds(
      normalizeMessagesForAPI(buildHistory()),
    )

    expect(toolUseId).toBe(SIGNED_ID)
    expect(toolResultId).toBe(SIGNED_ID)
  })
})

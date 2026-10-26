import { beforeEach, describe, expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage, deriveShortMessageId } from '../../utils/messages.js'
import {
  _resetForTesting,
  isSnipRuntimeEnabled,
  markForSnip,
  shouldNudgeForSnips,
  SNIP_NUDGE_TEXT,
  snipCompactIfNeeded,
} from './snipCompact.js'

beforeEach(() => {
  _resetForTesting()
})

function makeUser(uuid: string, text = 'hello') {
  const msg = createUserMessage({ content: text })
  return { ...msg, uuid }
}

function makeAssistant(uuid: string) {
  const msg = createAssistantMessage({ content: 'ok' })
  return { ...msg, uuid }
}

describe('isSnipRuntimeEnabled', () => {
  test('returns true', () => {
    expect(isSnipRuntimeEnabled()).toBe(true)
  })
})

describe('SNIP_NUDGE_TEXT', () => {
  test('is a non-empty string mentioning snip', () => {
    expect(typeof SNIP_NUDGE_TEXT).toBe('string')
    expect(SNIP_NUDGE_TEXT.length).toBeGreaterThan(20)
    expect(SNIP_NUDGE_TEXT.toLowerCase()).toContain('snip')
  })
})

describe('snipCompactIfNeeded', () => {
  test('no-ops when nothing is pending', () => {
    const messages = [makeUser('uuid-1'), makeUser('uuid-2')]
    const result = snipCompactIfNeeded(messages)
    expect(result.tokensFreed).toBe(0)
    expect(result.boundaryMessage).toBeUndefined()
    expect(result.messages).toHaveLength(2)
  })

  test('removes a message whose short ID was marked for snip', () => {
    const uuid = 'a1b2c3d4-0000-0000-0000-000000000001'
    const shortId = deriveShortMessageId(uuid)
    const messages = [makeUser(uuid, 'old stuff'), makeUser('keep-uuid', 'keep me')]
    markForSnip([shortId], messages)
    const result = snipCompactIfNeeded(messages)
    expect(result.messages.map((m) => m.uuid)).toEqual(['keep-uuid'])
    expect(result.tokensFreed).toBeGreaterThan(0)
  })

  test('returns a boundary message with snipMetadata.removedUuids', () => {
    const uuid = 'a1b2c3d4-0000-0000-0000-000000000002'
    const shortId = deriveShortMessageId(uuid)
    const messages = [makeUser(uuid)]
    markForSnip([shortId], messages)
    const result = snipCompactIfNeeded(messages)
    expect(result.boundaryMessage).toBeDefined()
    expect(result.boundaryMessage?.snipMetadata?.removedUuids).toContain(uuid)
  })

  test('clears pending set after execution so second call is a no-op', () => {
    const uuid = 'a1b2c3d4-0000-0000-0000-000000000003'
    const shortId = deriveShortMessageId(uuid)
    const messages = [makeUser(uuid), makeUser('other')]
    markForSnip([shortId], messages)
    snipCompactIfNeeded(messages)
    const second = snipCompactIfNeeded([makeUser('other')])
    expect(second.tokensFreed).toBe(0)
    expect(second.boundaryMessage).toBeUndefined()
  })

  test('also removes tool-result messages for snipped assistant tool calls', () => {
    const assistantUuid = 'aaaa0004-0000-0000-0000-000000000004'
    const toolUseId = 'tu-001'
    const shortId = deriveShortMessageId(assistantUuid)
    const assistantMsg = {
      ...makeAssistant(assistantUuid),
      message: {
        content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }],
      },
    }
    const toolResultMsg = {
      ...createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file contents' }],
      }),
      uuid: 'bbbb0041-0000-0000-0000-000000000041',
    }
    const messages = [assistantMsg, toolResultMsg, makeUser('survivor')]
    markForSnip([shortId], messages)
    const result = snipCompactIfNeeded(messages)
    expect(result.messages.map((m) => m.uuid ?? 'noid')).not.toContain(assistantUuid)
    const hasToolResult = result.messages.some((m) =>
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId)
    )
    expect(hasToolResult).toBe(false)
    expect(result.messages.some((m) => m.uuid === 'survivor')).toBe(true)
  })

  test('records paired tool-result UUIDs in removedUuids so replay drops the same set', () => {
    // The live snip drops both the assistant tool-use message AND its paired
    // tool-result user message; the persisted boundary must record both UUIDs,
    // otherwise projectSnippedView / loadTranscriptFile resurrect the orphaned
    // tool-result on --resume.
    const assistantUuid = 'aaaa0050-0000-0000-0000-000000000050'
    const toolResultUuid = 'bbbb0051-0000-0000-0000-000000000051'
    const toolUseId = 'tu-050'
    const shortId = deriveShortMessageId(assistantUuid)
    const assistantMsg = {
      ...makeAssistant(assistantUuid),
      message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }] },
    }
    const toolResultMsg = {
      ...createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file contents' }],
      }),
      uuid: toolResultUuid,
    }
    const messages = [assistantMsg, toolResultMsg, makeUser('survivor')]
    markForSnip([shortId], messages)
    const result = snipCompactIfNeeded(messages)
    const removed = result.boundaryMessage?.snipMetadata?.removedUuids ?? []
    expect(removed).toContain(assistantUuid)
    expect(removed).toContain(toolResultUuid)
  })

  test('snipping a tool-result user message also drops the paired assistant tool-use', () => {
    // [id:] tags are appended to USER messages only, so the model references a
    // tool-result user message. Dropping just that user message would orphan the
    // preceding assistant tool_use, which the next API-prep pass "repairs" with a
    // synthesized placeholder result — so the tool interaction is never actually
    // removed. The paired assistant tool-use must be dropped (and persisted) too.
    const assistantUuid = 'aaaa0060-0000-0000-0000-000000000060'
    const toolResultUuid = 'bbbb0061-0000-0000-0000-000000000061'
    const toolUseId = 'tu-060'
    const shortId = deriveShortMessageId(toolResultUuid)
    const assistantMsg = {
      ...makeAssistant(assistantUuid),
      message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }] },
    }
    const toolResultMsg = {
      ...createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file contents' }],
      }),
      uuid: toolResultUuid,
    }
    const messages = [assistantMsg, toolResultMsg, makeUser('survivor')]
    markForSnip([shortId], messages)
    const result = snipCompactIfNeeded(messages)
    // Both the tool-result user message and the assistant tool-use are gone from live context.
    expect(result.messages.map((m) => m.uuid)).toEqual(['survivor'])
    const hasToolUse = result.messages.some((m) =>
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_use' && b.id === toolUseId)
    )
    expect(hasToolUse).toBe(false)
    // Both UUIDs are persisted so replay drops the same set.
    const removed = result.boundaryMessage?.snipMetadata?.removedUuids ?? []
    expect(removed).toContain(toolResultUuid)
    expect(removed).toContain(assistantUuid)
  })

  test('does not drop a mixed-content assistant turn (text + tool_use) when only its result is snipped', () => {
    // An assistant turn that interleaves reasoning text with a tool_use is the
    // common shape. Snipping its paired tool-result must NOT drop the whole
    // assistant message, because that would silently delete the text block the
    // model never asked to remove. The paired-drop only fires when the turn is
    // entirely tool blocks; here it is not, so the snip is a clean no-op.
    const assistantUuid = 'aaaa0080-0000-0000-0000-000000000080'
    const toolResultUuid = 'bbbb0081-0000-0000-0000-000000000081'
    const toolUseId = 'tu-080'
    const assistantMsg = {
      ...makeAssistant(assistantUuid),
      message: {
        content: [
          { type: 'text', text: 'reasoning worth keeping' },
          { type: 'tool_use', id: toolUseId, name: 'Read', input: {} },
        ],
      },
    }
    const toolResultMsg = {
      ...createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file contents' }],
      }),
      uuid: toolResultUuid,
    }
    const messages = [assistantMsg, toolResultMsg, makeUser('survivor')]
    markForSnip([deriveShortMessageId(toolResultUuid)], messages)
    const result = snipCompactIfNeeded(messages)
    // No-op: the mixed-content assistant (and its text) and the tool-result both survive.
    expect(result.messages.map((m) => m.uuid)).toContain(assistantUuid)
    expect(result.messages.map((m) => m.uuid)).toContain(toolResultUuid)
    expect(result.tokensFreed).toBe(0)
    expect(result.boundaryMessage).toBeUndefined()
  })

  test('does not snip a tool result when its paired assistant tool_use would survive', () => {
    // An assistant turn with two tool calls whose results land in two separate
    // user messages: snipping only one result cannot cleanly remove the tool
    // interaction. The assistant's other tool call still has a live result, so
    // the assistant must stay; but dropping just resultA would leave the assistant
    // holding tu-A with no matching result, which the next API-prep pass "repairs"
    // with a synthetic placeholder (so the snip never actually takes effect).
    // Block-level surgery on the assistant would not survive --resume replay
    // (projectSnippedView drops whole UUIDs, not blocks). So this is a no-op:
    // resultA is kept and nothing is recorded as snipped.
    const assistantUuid = 'aaaa0070-0000-0000-0000-000000000070'
    const resultAUuid = 'bbbb0071-0000-0000-0000-000000000071'
    const resultBUuid = 'cccc0072-0000-0000-0000-000000000072'
    const assistantMsg = {
      ...makeAssistant(assistantUuid),
      message: {
        content: [
          { type: 'tool_use', id: 'tu-A', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu-B', name: 'Read', input: {} },
        ],
      },
    }
    const resultA = {
      ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tu-A', content: 'a' }] }),
      uuid: resultAUuid,
    }
    const resultB = {
      ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tu-B', content: 'b' }] }),
      uuid: resultBUuid,
    }
    const messages = [assistantMsg, resultA, resultB]
    markForSnip([deriveShortMessageId(resultAUuid)], messages)
    const result = snipCompactIfNeeded(messages)
    // Nothing is removed: the interaction can't be cleanly snipped.
    expect(result.messages.map((m) => m.uuid)).toContain(assistantUuid)
    expect(result.messages.map((m) => m.uuid)).toContain(resultBUuid)
    expect(result.messages.map((m) => m.uuid)).toContain(resultAUuid)
    expect(result.tokensFreed).toBe(0)
    expect(result.boundaryMessage).toBeUndefined()
  })

  test('pending snips are scoped per conversation by resolved UUID', () => {
    // Models two concurrent in-process sessions sharing this module-level
    // registry. Session A marks a snip; session B reaches snipCompactIfNeeded
    // first with its own (unrelated) messages. B must NOT consume or lose A's
    // pending removal, and must NOT prune one of its own messages by mistake.
    const aUuid = 'cccc00a1-0000-0000-0000-0000000000a1'
    const aMessages = [makeUser(aUuid, 'session A stale'), makeUser('a-keep', 'keep')]
    markForSnip([deriveShortMessageId(aUuid)], aMessages)

    const bMessages = [makeUser('b1', 'session B one'), makeUser('b2', 'session B two')]
    const bResult = snipCompactIfNeeded(bMessages)
    expect(bResult.tokensFreed).toBe(0)
    expect(bResult.boundaryMessage).toBeUndefined()
    expect(bResult.messages).toHaveLength(2)

    // A's pending removal survived B's pass and still applies to A's context.
    const aResult = snipCompactIfNeeded(aMessages)
    expect(aResult.messages.map((m) => m.uuid)).toEqual(['a-keep'])
    expect(aResult.boundaryMessage?.snipMetadata?.removedUuids).toContain(aUuid)
  })

  test('ignores short IDs that do not match any message (graceful)', () => {
    const messages = [makeUser('real-uuid')]
    markForSnip(['xxxxxx'], messages)
    const result = snipCompactIfNeeded(messages)
    expect(result.messages).toHaveLength(1)
    expect(result.tokensFreed).toBe(0)
    expect(result.boundaryMessage).toBeUndefined()
  })
})

describe('markForSnip', () => {
  test('returns only the UUIDs that resolved against the conversation', () => {
    // The model can pass stale or hallucinated short IDs. markForSnip enqueues
    // only IDs it can resolve, so its return value (which SnipTool reports as the
    // queued count) must exclude the unresolved ones rather than echoing the raw
    // request length.
    const realUuid = 'a1b2c3d4-0000-0000-0000-0000000000aa'
    const messages = [makeUser(realUuid)]
    const matched = markForSnip([deriveShortMessageId(realUuid), 'xxxxxx'], messages)
    expect(matched).toEqual([realUuid])
  })

  test('accepts legacy bracketed id syntax from older contexts', () => {
    const realUuid = 'a1b2c3d4-0000-0000-0000-0000000000bb'
    const messages = [makeUser(realUuid)]
    const matched = markForSnip(
      [`[id:${deriveShortMessageId(realUuid)}]`],
      messages,
    )
    expect(matched).toEqual([realUuid])
  })

  test('accepts snip_id-prefixed metadata syntax', () => {
    const realUuid = 'a1b2c3d4-0000-0000-0000-0000000000cc'
    const messages = [makeUser(realUuid)]
    const matched = markForSnip(
      [`snip_id=${deriveShortMessageId(realUuid)}`],
      messages,
    )
    expect(matched).toEqual([realUuid])
  })

  test('accepts copied system-reminder metadata syntax', () => {
    const realUuid = 'a1b2c3d4-0000-0000-0000-0000000000dd'
    const messages = [makeUser(realUuid)]
    const id = deriveShortMessageId(realUuid)
    const matched = markForSnip(
      [
        `<system-reminder>snip_id=${id}; system-generated; for snip tool use only;</system-reminder>`,
      ],
      messages,
    )
    expect(matched).toEqual([realUuid])
  })
})

describe('shouldNudgeForSnips', () => {
  test('returns false for an empty message list', () => {
    expect(shouldNudgeForSnips([])).toBe(false)
  })

  test('returns false when there is a compact_boundary in recent history', () => {
    const messages = [
      { type: 'system', subtype: 'compact_boundary' },
      makeUser('u1', 'x'.repeat(200)),
    ]
    expect(shouldNudgeForSnips(messages)).toBe(false)
  })

  test('returns false when there is a snip boundary in recent history', () => {
    const messages = [
      { type: 'system', snipMetadata: { removedUuids: [] } },
      makeUser('u1', 'x'.repeat(200)),
    ]
    expect(shouldNudgeForSnips(messages)).toBe(false)
  })

  test('resets at a previous context-efficiency nudge until enough new content accumulates', () => {
    const priorNudge = {
      type: 'attachment',
      attachment: { type: 'context_efficiency' },
    }
    const smallChunk = 'x'.repeat(12_000)
    const oldChunkBeforeNudge = 'x'.repeat(36_000)
    const largeRecent = [
      makeUser('u1', smallChunk),
      makeUser('u2', smallChunk),
      makeUser('u3', smallChunk),
      makeUser('u4', smallChunk),
    ]

    expect(
      shouldNudgeForSnips([
        makeUser('u0', oldChunkBeforeNudge),
        priorNudge,
        makeUser('u5', smallChunk),
      ]),
    ).toBe(false)
    expect(shouldNudgeForSnips([priorNudge, ...largeRecent])).toBe(true)
  })

  test('returns true when enough tokens have accumulated since last reset', () => {
    const bigChunk = 'x'.repeat(12_000)
    const messages = [
      makeUser('u1', bigChunk),
      makeUser('u2', bigChunk),
      makeUser('u3', bigChunk),
      makeUser('u4', bigChunk),
    ]
    expect(shouldNudgeForSnips(messages)).toBe(true)
  })

  test('respects a custom interval threshold', () => {
    const bigChunk = 'x'.repeat(12_000)
    const messages = [
      makeUser('u1', bigChunk),
      makeUser('u2', bigChunk),
      makeUser('u3', bigChunk),
      makeUser('u4', bigChunk),
    ]

    expect(shouldNudgeForSnips(messages, 10_000)).toBe(true)
    expect(shouldNudgeForSnips(messages, 50_000)).toBe(false)
  })
})

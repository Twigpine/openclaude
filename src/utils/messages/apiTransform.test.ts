import { describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  mergeUserMessages,
  normalizeMessagesForAPI,
} from '../messages.js'
import { getImageTooLargeErrorMessage } from '../../services/api/errors.js'
import {
  appendMessageTagToUserMessage,
  deriveShortMessageId,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from './apiTransform.js'
import type { UserMessage } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments.js'

const UUID = 'a1b2c3d4-0000-0000-0000-000000000099'
const UUID_B = 'b2c3d4e5-0000-0000-0000-000000000088'

function tagFor(uuid: string): string {
  return `snip_id=${deriveShortMessageId(uuid)}`
}

function countTags(out: UserMessage): number {
  const c = out.message.content
  const s = typeof c === 'string' ? c : JSON.stringify(c)
  return (s.match(/snip_id=/g) || []).length
}

describe('appendMessageTagToUserMessage', () => {
  test('normalizing meta context honors snip merge semantics', () => {
    const reminder = createUserMessage({ content: 'context', isMeta: true })
    const correction = createUserMessage({ content: 'do Y instead' })

    const [merged] = normalizeMessagesForAPI([reminder, correction])

    expect(merged?.isMeta).toBe(feature('HISTORY_SNIP') ? undefined : true)
    expect(JSON.stringify(merged?.message.content)).toContain('context')
    expect(JSON.stringify(merged?.message.content)).toContain('do Y instead')
  })

  test(
    'retries strip a rejected image after it merged with a prompt',
    () => {
      const attachment = createUserMessage({
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'oversized-image',
            },
          },
        ],
        isMeta: true,
      })
      const prompt = createUserMessage({ content: 'describe this image' })
      const imageError = createAssistantAPIErrorMessage({
        content: getImageTooLargeErrorMessage(),
      })

      const retry = normalizeMessagesForAPI([attachment, prompt, imageError])
      const retryContent = JSON.stringify(retry[0]?.message.content)

      expect(retryContent).toContain('describe this image')
      expect(retryContent).not.toContain('oversized-image')
      expect(retryContent).not.toContain('"type":"image"')
    },
  )

  test('retries strip an oversized pasted image on an ordinary user prompt', () => {
    const prompt = createUserMessage({
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'oversized-pasted-image' } }, { type: 'text', text: 'describe this image' }],
    })
    const retry = normalizeMessagesForAPI([
      prompt,
      createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() }),
    ])
    const retryContent = JSON.stringify(retry[0]?.message.content)

    expect(retryContent).toContain('describe this image')
    expect(retryContent).not.toContain('oversized-pasted-image')
  })

  test('keeps a placeholder for an image-only pasted prompt on retry', () => {
    const prompt = createUserMessage({
      content: [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'image-only-prompt',
        },
      }],
    })
    const retry = normalizeMessagesForAPI([
      prompt,
      createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() }),
    ])
    const retryContent = JSON.stringify(retry[0]?.message.content)

    expect(retryContent).toContain('Media removed after provider rejection.')
    expect(retryContent).not.toContain('image-only-prompt')
  })

  test('retries strip rejected media from a file attachment', () => {
    const attachment = createAttachmentMessage({
      type: 'file',
      filename: '/tmp/oversized.png',
      displayPath: 'oversized.png',
      content: {
        type: 'image',
        file: {
          base64: 'attachment-image',
          type: 'image/png',
          originalSize: 1,
        },
      },
    })
    const retry = normalizeMessagesForAPI([
      createUserMessage({ content: 'describe this file' }),
      attachment,
      createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() }),
    ])
    const retryContent = JSON.stringify(retry.map(message => message.message.content))

    expect(retryContent).toContain('Media removed after provider rejection.')
    expect(retryContent).not.toContain('attachment-image')
  })

  test('retries strip rejected media nested in a tool result', () => {
    const toolResult = createUserMessage({
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_oversized_image',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'nested-oversized-image',
            },
          },
          { type: 'text', text: 'remaining tool output' },
        ],
      }],
    })
    const retry = normalizeMessagesForAPI([
      toolResult,
      createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() }),
    ])
    const retryContent = JSON.stringify(retry[0]?.message.content)

    expect(retryContent).toContain('remaining tool output')
    expect(retryContent).not.toContain('nested-oversized-image')
    expect(retryContent).not.toContain('"type":"image"')
  })

  test('keeps a placeholder when nested media is the only tool result', () => {
    const toolResult = createUserMessage({
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_image_only',
        content: [{
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'only-nested-image',
          },
        }],
      }],
    })
    const retry = normalizeMessagesForAPI([
      toolResult,
      createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() }),
    ])
    const retryContent = JSON.stringify(retry[0]?.message.content)

    expect(retryContent).toContain('Media removed after provider rejection.')
    expect(retryContent).not.toContain('only-nested-image')
    expect(retryContent).not.toContain('"type":"image"')
  })

  test('strips every ambiguous image attachment in the failed turn', () => {
    const oldAttachment = createUserMessage({
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'old-invalid-image' } }],
      isMeta: true,
    })
    const laterAttachment = createUserMessage({
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'latest-valid-image' } }, { type: 'text', text: 'describe this screenshot' }],
    })
    const retry = normalizeMessagesForAPI([
      oldAttachment,
      laterAttachment,
      createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() }),
    ])
    const retryContent = JSON.stringify(retry[0]?.message.content)

    expect(retryContent).toContain('describe this screenshot')
    expect(retryContent).not.toContain('old-invalid-image')
    expect(retryContent).not.toContain('latest-valid-image')
  })

  test('strips an earlier image past a different meta attachment', () => {
    const image = createUserMessage({
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'oversized-image' } }],
      isMeta: true,
    })
    const pdf = createUserMessage({
      content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'valid-pdf' } }],
      isMeta: true,
    })
    const prompt = createUserMessage({ content: 'describe both attachments' })
    const retry = normalizeMessagesForAPI([
      image,
      pdf,
      prompt,
      createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() }),
    ])
    const retryContent = JSON.stringify(retry[0]?.message.content)

    expect(retryContent).toContain('valid-pdf')
    expect(retryContent).toContain('describe both attachments')
    expect(retryContent).not.toContain('oversized-image')
  })

  test('appends internal snip metadata to string content', () => {
    const msg = { ...createUserMessage({ content: 'hello' }), uuid: UUID }
    const out = appendMessageTagToUserMessage(msg as UserMessage)
    expect(out.message.content).toContain('hello')
    expect(out.message.content).toContain(tagFor(UUID))
    expect(out.message.content).toContain('do not discuss in thinking')
    expect(out.message.content).not.toContain('[id:')
    expect(out.message.content).not.toContain('user-provided')
  })

  test('appends internal snip metadata to the last text block of array content', () => {
    const msg = {
      ...createUserMessage({
        content: [{ type: 'text', text: 'first' }],
      }),
      uuid: UUID,
    }
    const out = appendMessageTagToUserMessage(msg as UserMessage)
    const blocks = out.message.content as any[]
    expect(blocks[blocks.length - 1].text).toContain('first')
    expect(blocks[blocks.length - 1].text).toContain(tagFor(UUID))
    expect(blocks[blocks.length - 1].text).toContain('do not discuss in thinking')
    expect(blocks[blocks.length - 1].text).not.toContain('[id:')
    expect(blocks[blocks.length - 1].text).not.toContain('user-provided')
  })

  test('adds internal snip metadata to a pure tool_result message (large Read/Bash output)', () => {
    const msg = {
      ...createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_abc',
            content: 'a huge file read',
          },
        ],
      }),
      uuid: UUID,
    }
    const out = appendMessageTagToUserMessage(msg as UserMessage)
    const blocks = out.message.content as any[]
    // The tool_result block is preserved so snip pairing still works.
    expect(blocks.some(b => b.type === 'tool_result')).toBe(true)
    // Internal metadata is present for snip without looking user-authored.
    const flattened = JSON.stringify(blocks)
    expect(flattened).toContain(tagFor(UUID))
    expect(flattened).toContain('do not discuss in thinking')
    expect(flattened).not.toContain('[id:')
    expect(flattened).not.toContain('user-provided')
  })

  test('leaves a meta message untouched', () => {
    const msg = {
      ...createUserMessage({ content: 'meta', isMeta: true }),
      uuid: UUID,
    }
    const out = appendMessageTagToUserMessage(msg as UserMessage)
    expect(out.message.content).toBe('meta')
  })

  // normalizeMessagesForAPI re-runs over messages carried forward as loop state
  // (query.ts builds toolResults from its own normalized output), so a message
  // can reach this function already tagged. Re-appending must not stack a second
  // [id:] tag, or every prior tool result accumulates duplicates each turn.
  test('is idempotent for string content', () => {
    const msg = { ...createUserMessage({ content: 'hello' }), uuid: UUID }
    const once = appendMessageTagToUserMessage(msg as UserMessage)
    const twice = appendMessageTagToUserMessage(once as UserMessage)
    expect(countTags(twice)).toBe(1)
    expect(twice.message.content).toBe(once.message.content)
  })

  test('is idempotent for array text-block content', () => {
    const msg = {
      ...createUserMessage({ content: [{ type: 'text', text: 'first' }] }),
      uuid: UUID,
    }
    const once = appendMessageTagToUserMessage(msg as UserMessage)
    const twice = appendMessageTagToUserMessage(once as UserMessage)
    expect(countTags(twice)).toBe(1)
  })

  test('is idempotent for pure tool_result content', () => {
    const msg = {
      ...createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'big read' },
        ],
      }),
      uuid: UUID,
    }
    const once = appendMessageTagToUserMessage(msg as UserMessage)
    const twice = appendMessageTagToUserMessage(once as UserMessage)
    expect(countTags(twice)).toBe(1)
    const blocks = twice.message.content as any[]
    // Exactly one added text block, and the tool_result is preserved.
    expect(blocks.filter(b => b.type === 'text').length).toBe(1)
    expect(blocks.some(b => b.type === 'tool_result')).toBe(true)
  })

  // normalizeMessagesForAPI tags each user message BEFORE merging consecutive
  // ones, so a parallel-tool turn's adjacent tool_result siblings each carry
  // their own [id:] before mergeUserMessages folds them. The merge keeps only
  // the first operand's uuid, so a single sibling's id would be exposed if we
  // tagged after merging. snipCompactIfNeeded refuses to drop one result of such
  // a turn (it would orphan the surviving tool_use), so the model must be able to
  // name every sibling to remove the whole turn. This pins that the merge keeps
  // every pre-merge [id:] tag.
  test('merging tagged parallel tool-result siblings keeps every sibling id', () => {
    const resultA = appendMessageTagToUserMessage({
      ...createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: 'tu-A', content: 'a' }],
      }),
      uuid: UUID,
    } as UserMessage)
    const resultB = appendMessageTagToUserMessage({
      ...createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: 'tu-B', content: 'b' }],
      }),
      uuid: UUID_B,
    } as UserMessage)

    const merged = mergeUserMessages(resultA, resultB)
    const flattened = JSON.stringify(merged.message.content)
    // Both siblings' ids survive the merge, so both are snippable.
    expect(flattened).toContain(tagFor(UUID))
    expect(flattened).toContain(tagFor(UUID_B))
    expect(flattened).not.toContain('[id:')
    // Both tool_result blocks are preserved for snip pairing.
    const blocks = merged.message.content as any[]
    expect(blocks.filter(b => b.type === 'tool_result').length).toBe(2)
  })

  test('merging tool-result siblings keeps permission attachment ownership', () => {
    const resultA = createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'tu-A', content: 'a' }],
    })
    const resultB = createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 'tu-B', content: 'b' }],
      imagePermissionToolUseIds: ['tu-B'],
    })

    expect(mergeUserMessages(resultA, resultB).imagePermissionToolUseIds)
      .toEqual(['tu-B'])
  })
})

describe('API cleanup transforms', () => {
  test('removes tool-reference blocks while preserving other tool-result content', () => {
    const message = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc',
          content: [
            { type: 'tool_reference', tool_name: 'mcp__example__search' },
            { type: 'text', text: 'keep this result' },
          ],
        },
      ],
    })

    const output = stripToolReferenceBlocksFromUserMessage(message)
    const content = (output.message.content as any[])[0].content
    expect(content).toEqual([{ type: 'text', text: 'keep this result' }])
  })

  test('removes a nullable caller field from tool-use blocks', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_abc', name: 'Read', input: {}, caller: null },
          { type: 'text', text: 'keep this text block' },
        ],
      },
    }

    const output = stripCallerFieldFromAssistantMessage(message as any)
    expect(output.message.content[0]).not.toHaveProperty('caller')
    expect(output.message.content[1] as any).toEqual({
      type: 'text',
      text: 'keep this text block',
    })
  })
})

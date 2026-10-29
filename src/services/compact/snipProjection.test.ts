import { describe, expect, test } from 'bun:test'
import { isSnipBoundaryMessage, projectSnippedView } from './snipProjection.js'

describe('isSnipBoundaryMessage', () => {
  test('returns true for message with snipMetadata', () => {
    const msg = { type: 'system', snipMetadata: { removedUuids: ['abc'] } }
    expect(isSnipBoundaryMessage(msg)).toBe(true)
  })

  test('returns false for compact_boundary without snipMetadata', () => {
    const msg = { type: 'system', subtype: 'compact_boundary', compactMetadata: {} }
    expect(isSnipBoundaryMessage(msg)).toBe(false)
  })

  test('returns false for regular message', () => {
    expect(isSnipBoundaryMessage({ type: 'user', uuid: 'abc' })).toBe(false)
  })

  test('returns false for null/undefined', () => {
    expect(isSnipBoundaryMessage(null)).toBe(false)
    expect(isSnipBoundaryMessage(undefined)).toBe(false)
  })
})

describe('projectSnippedView', () => {
  test('returns original array when no snip boundaries present', () => {
    const messages = [
      { uuid: 'aaa', type: 'user' },
      { uuid: 'bbb', type: 'assistant' },
    ]
    expect(projectSnippedView(messages)).toEqual(messages)
  })

  test('removes messages whose UUIDs appear in snipMetadata.removedUuids', () => {
    const messages = [
      { uuid: 'aaa', type: 'user' },
      { uuid: 'bbb', type: 'assistant' },
      { uuid: 'ccc', type: 'user' },
      { uuid: 'snip-boundary', type: 'system', snipMetadata: { removedUuids: ['aaa', 'bbb'] } },
      { uuid: 'ddd', type: 'user' },
    ]
    const result = projectSnippedView(messages)
    expect(result.map((m) => m.uuid)).toEqual(['ccc', 'snip-boundary', 'ddd'])
  })

  test('accumulates removedUuids from multiple snip boundaries', () => {
    const messages = [
      { uuid: 'aaa', type: 'user' },
      { uuid: 'b1', type: 'system', snipMetadata: { removedUuids: ['aaa'] } },
      { uuid: 'bbb', type: 'user' },
      { uuid: 'b2', type: 'system', snipMetadata: { removedUuids: ['bbb'] } },
      { uuid: 'ccc', type: 'user' },
    ]
    const result = projectSnippedView(messages)
    expect(result.map((m) => m.uuid)).toEqual(['b1', 'b2', 'ccc'])
  })

  test('handles boundaries with no removedUuids gracefully', () => {
    const messages = [
      { uuid: 'aaa', type: 'user' },
      { uuid: 'bnd', type: 'system', snipMetadata: {} },
    ]
    expect(projectSnippedView(messages).length).toBe(2)
  })

  // Mirrors the snipReplay path in QueryEngine: the boundary is appended to
  // the store and the removed messages precede it. Prunes regardless of order.
  test('prunes earlier messages when the boundary is appended last', () => {
    const store = [
      { uuid: 'aaa', type: 'user' },
      { uuid: 'bbb', type: 'assistant' },
      { uuid: 'ccc', type: 'user' },
    ]
    const boundary = {
      uuid: 'bnd',
      type: 'system',
      snipMetadata: { removedUuids: ['aaa', 'bbb'] },
    }
    const result = projectSnippedView([...store, boundary])
    expect(result.map((m) => m.uuid)).toEqual(['ccc', 'bnd'])
  })
})

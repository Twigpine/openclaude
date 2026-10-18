import { describe, expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createUserMessage,
} from '../messages.js'
import {
  normalizeMessages,
  normalizeMessagesCached,
} from './normalize.js'
import type { Message } from '../../types/message.js'

// normalizeMessagesCached must be observably identical to normalizeMessages
// for every mutation pattern the REPL produces (append, replace-last, filter,
// slice/rewind), while additionally preserving object identity for unchanged
// messages so downstream memo/WeakMap caches survive.

let uuidCounter = 0
function withUuid<T extends Message>(message: T): T {
  uuidCounter += 1
  const hex = uuidCounter.toString(16).padStart(12, '0')
  return { ...message, uuid: `a1b2c3d4-0000-0000-0000-${hex}` as Message['uuid'] }
}

function assistant(...texts: string[]): Message {
  return withUuid(
    createAssistantMessage({
      content: texts.map(
        text => ({ type: 'text' as const, text, citations: null }) as never,
      ),
    }),
  )
}

function user(text: string): Message {
  return withUuid(createUserMessage({ content: text })) as Message
}

function expectEquivalent(messages: Message[]): void {
  expect(normalizeMessagesCached(messages)).toEqual(normalizeMessages(messages))
}

describe('normalizeMessages', () => {
  test('keeps each split permission image paired with its own tool result', () => {
    const message = withUuid(createUserMessage({
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'one' } },
        { type: 'text', text: 'between images' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'two' } },
      ],
      imagePermissionToolUseIds: ['toolu_one', 'toolu_two'],
    }))

    const normalized = normalizeMessages([message])
    expect(normalized.map(item => item.imagePermissionToolUseIds)).toEqual([
      ['toolu_one'],
      undefined,
      ['toolu_two'],
    ])
  })
})

describe('normalizeMessagesCached', () => {
  test('matches normalizeMessages for single-block messages', () => {
    expectEquivalent([user('hi'), assistant('hello'), user('bye')])
  })

  test('matches across an isNewChain transition (multi-block message)', () => {
    expectEquivalent([
      user('q'),
      assistant('part one', 'part two'),
      user('follow up'),
      assistant('answer'),
    ])
  })

  test('matches when the chain flag is already set before a later message', () => {
    // The multi-block assistant sets isNewChain; every later message must get
    // derived UUIDs in both implementations.
    expectEquivalent([
      assistant('a', 'b', 'c'),
      user('next'),
      assistant('single'),
      user('again'),
    ])
  })

  test('matches after an append (incremental growth)', () => {
    const base = [user('1'), assistant('one'), user('2')]
    expectEquivalent(base)
    expectEquivalent([...base, assistant('two')])
    expectEquivalent([...base, assistant('two'), user('3')])
  })

  test('matches after replacing the last message', () => {
    const base = [user('1'), assistant('streaming...')]
    expectEquivalent(base)
    expectEquivalent([base[0]!, assistant('final answer')])
  })

  test('matches after filtering out a middle message', () => {
    const a = user('1')
    const b = assistant('two')
    const c = user('3')
    expectEquivalent([a, b, c])
    expectEquivalent([a, c])
  })

  test('matches after a rewind slice', () => {
    const full = [user('1'), assistant('two', 'three'), user('4'), assistant('5')]
    expectEquivalent(full)
    expectEquivalent(full.slice(0, 2))
    expectEquivalent(full.slice(0, 1))
  })

  test('preserves object identity for unchanged messages on pure append', () => {
    const a = user('1')
    const b = assistant('two')
    const first = normalizeMessagesCached([a, b])
    const second = normalizeMessagesCached([a, b, user('3')])
    // The normalized outputs for a and b must be the very same objects.
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
  })

  test('preserves identity for messages before a newly multi-block tail', () => {
    const a = user('1')
    const b = assistant('two')
    const first = normalizeMessagesCached([a, b])
    // Appending a multi-block message after b does not change b's entry flag
    // (still false), so b's normalized output identity is retained.
    const second = normalizeMessagesCached([a, b, assistant('x', 'y')])
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
  })

  // The cache is keyed by (message identity, entryFlag). The dangerous path is
  // reusing the SAME trailing message object across both flag states: a rewind
  // that removes an earlier multi-block message flips a later message's entry
  // flag true -> false, which must drop its derived UUIDs and recompute rather
  // than return the stale true-flag entry.
  test('recomputes a reused trailing message when its entry flag flips true -> false', () => {
    const q = user('q')
    const multi = assistant('a', 'b') // sets isNewChain = true
    const tail = assistant('tail')

    // Warm the cache: `tail` follows a multi-block message, so entryFlag = true.
    const withMulti = normalizeMessagesCached([q, multi, tail])
    expect(withMulti).toEqual(normalizeMessages([q, multi, tail]))

    // Rewind: drop the multi-block message. `tail` (same object) now has
    // entryFlag = false. The cache must recompute, not reuse the true-flag entry.
    expectEquivalent([q, tail])

    // And the false-flag tail output must differ from the cached true-flag one.
    const withoutMulti = normalizeMessagesCached([q, tail])
    expect(withoutMulti[withoutMulti.length - 1]).not.toBe(
      withMulti[withMulti.length - 1],
    )
  })

  // The reverse transition (false -> true) on a reused object must also recompute.
  test('recomputes a reused trailing message when its entry flag flips false -> true', () => {
    const q = user('q')
    const multi = assistant('a', 'b')
    const tail = assistant('tail')

    // Warm the cache with entryFlag = false (no preceding multi-block message).
    normalizeMessagesCached([q, tail])
    // Insert a multi-block message before `tail`: entryFlag becomes true.
    expectEquivalent([q, multi, tail])
  })
})

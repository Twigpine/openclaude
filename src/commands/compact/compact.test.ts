import { afterEach, expect, mock, test } from 'bun:test'

import type { Message } from '../../types/message.js'
import { createCompactBoundaryMessage } from '../../utils/messages/systemFactories.js'

const realSessionMemoryCompact = await import(
  `../../services/compact/sessionMemoryCompact.js?real=${Date.now()}-${Math.random()}`
)

afterEach(() => {
  mock.restore()
  mock.module('../../services/compact/sessionMemoryCompact.js', () => ({
    ...realSessionMemoryCompact,
  }))
})

test('session-memory /compact records a manual compact boundary', async () => {
  // The shared session-memory builder marks its boundary auto.
  const boundaryMarker = createCompactBoundaryMessage('auto', 10_000)
  mock.module('../../services/compact/sessionMemoryCompact.js', () => ({
    ...realSessionMemoryCompact,
    trySessionMemoryCompaction: mock(async () => ({
      boundaryMarker,
      summaryMessages: [],
      attachments: [],
      hookResults: [],
    })),
  }))
  const { call } = await import(
    `./compact.ts?test=${Date.now()}-${Math.random()}`
  )

  const message: Message = {
    type: 'user',
    message: { role: 'user', content: 'hello' },
    uuid: 'compact-test-user' as Message['uuid'],
    timestamp: new Date().toISOString(),
  }
  const result = await call('', {
    abortController: new AbortController(),
    messages: [message],
    options: { verbose: true },
  } as never)

  expect(result.type).toBe('compact')
  if (result.type !== 'compact') throw new Error('expected compact result')
  expect(result.compactionResult.boundaryMarker.compactMetadata.trigger).toBe(
    'manual',
  )
})

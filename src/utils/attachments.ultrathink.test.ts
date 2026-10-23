import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { snapshotEnv } from '../test/envSnapshot.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

// Keep a copy: mock.module also repoints an imported module namespace.
const realThinking = {
  ...await import(`./thinking.js?real=${Date.now()}-${Math.random()}`),
}

let getUltrathinkEffortAttachment: typeof import('./attachments.js').getUltrathinkEffortAttachment
let restoreEnv: () => void

beforeEach(async () => {
  await acquireSharedMutationLock('utils/attachments.ultrathink.test.ts')
  restoreEnv = snapshotEnv([
    'CLAUDE_CODE_DISABLE_ATTACHMENTS',
    'CLAUDE_CODE_SIMPLE',
  ], { clear: true })
  mock.module('./thinking.js', () => ({
    ...realThinking,
    isUltrathinkEnabled: () => true,
  }))
  ;({ getUltrathinkEffortAttachment } = await import(
    `./attachments.ts?test=${Date.now()}-${Math.random()}`
  ))
})

afterEach(() => {
  try {
    restoreEnv()
    mock.restore()
    // Bun's mock.restore() does not unregister module mocks.
    mock.module('./thinking.js', () => realThinking)
  } finally {
    releaseSharedMutationLock()
  }
})

test('ultrathink helper honors global attachment opt-outs', () => {
  expect(getUltrathinkEffortAttachment('ultrathink solve this', false)).toEqual([
    { type: 'ultrathink_effort', level: 'high' },
  ])

  process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
  expect(getUltrathinkEffortAttachment('ultrathink solve this', false)).toEqual([])

  delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
  process.env.CLAUDE_CODE_SIMPLE = '1'
  expect(getUltrathinkEffortAttachment('ultrathink solve this', false)).toEqual([])
})

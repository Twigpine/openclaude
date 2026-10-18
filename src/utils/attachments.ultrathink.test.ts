import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import * as realThinking from './thinking.js'

let getUltrathinkEffortAttachment: typeof import('./attachments.js').getUltrathinkEffortAttachment
let savedEnv: {
  disableAttachments: string | undefined
  simple: string | undefined
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/attachments.ultrathink.test.ts')
  savedEnv = {
    disableAttachments: process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS,
    simple: process.env.CLAUDE_CODE_SIMPLE,
  }
  delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
  delete process.env.CLAUDE_CODE_SIMPLE
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
    if (savedEnv.disableAttachments === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    } else {
      process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = savedEnv.disableAttachments
    }
    if (savedEnv.simple === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = savedEnv.simple
    }
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

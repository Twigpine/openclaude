import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getCachedMiniMaxModelOptions } from './minimaxModels.js'

const ORIGINAL_MINIMAX_API_KEY = process.env.MINIMAX_API_KEY

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/minimaxModels.test.ts')
  process.env.MINIMAX_API_KEY = 'minimax-test'
})

afterEach(() => {
  try {
    if (ORIGINAL_MINIMAX_API_KEY === undefined) {
      delete process.env.MINIMAX_API_KEY
    } else {
      process.env.MINIMAX_API_KEY = ORIGINAL_MINIMAX_API_KEY
    }
  } finally {
    releaseSharedMutationLock()
  }
})

test('MiniMax picker offers Flash first, M3, and unchanged vision models', () => {
  const values = getCachedMiniMaxModelOptions().map(option => option.value)

  expect(values).toEqual([
    'MiniMax-M3.1-Flash',
    'MiniMax-M3',
    'MiniMax-Vision-01',
    'MiniMax-Vision-01-Fast',
  ])
})

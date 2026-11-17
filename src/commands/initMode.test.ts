import { afterEach, describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { isNewInitEnabled } from './initMode.js'

const SAVED_USER_TYPE = process.env.USER_TYPE
const SAVED_NEW_INIT = process.env.CLAUDE_CODE_NEW_INIT

afterEach(() => {
  if (SAVED_USER_TYPE === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = SAVED_USER_TYPE
  }
  if (SAVED_NEW_INIT === undefined) {
    delete process.env.CLAUDE_CODE_NEW_INIT
  } else {
    process.env.CLAUDE_CODE_NEW_INIT = SAVED_NEW_INIT
  }
})

describe('isNewInitEnabled', () => {
  test('honors CLAUDE_CODE_NEW_INIT only when the build flag is on', () => {
    delete process.env.USER_TYPE
    process.env.CLAUDE_CODE_NEW_INIT = '1'
    const expected = feature('NEW_INIT') ? true : false
    expect(isNewInitEnabled()).toBe(expected)
  })

  test('stays off without an opt-in even when the build flag is on', () => {
    delete process.env.USER_TYPE
    delete process.env.CLAUDE_CODE_NEW_INIT
    expect(isNewInitEnabled()).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  MAX_MESSAGE_LENGTH,
  MAX_PATH_LENGTH,
  MAX_SESSION_ID_LENGTH,
  validateChatRequest,
} from './validation.js'

describe('validateChatRequest', () => {
  test('accepts a minimal valid request', () => {
    const result = validateChatRequest({ message: 'hello' })
    expect(result).toEqual({ ok: true, value: { message: 'hello' } })
  })

  test('accepts and normalises optional fields', () => {
    const result = validateChatRequest({
      message: 'hello',
      working_directory: '/tmp/work',
      session_id: 'cli-session-1',
      model: 'gpt-5',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        message: 'hello',
        workingDirectory: '/tmp/work',
        sessionId: 'cli-session-1',
        model: 'gpt-5',
      })
    }
  })

  test('drops empty optional fields', () => {
    const result = validateChatRequest({
      message: 'hello',
      working_directory: '',
      session_id: '',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ message: 'hello' })
    }
  })

  test('rejects a missing message', () => {
    expect(validateChatRequest({}).ok).toBe(false)
    expect(validateChatRequest({ message: '' }).ok).toBe(false)
  })

  test('rejects a non-string message', () => {
    expect(validateChatRequest({ message: 42 }).ok).toBe(false)
  })

  test('rejects an over-long message', () => {
    const result = validateChatRequest({
      message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1),
    })
    expect(result.ok).toBe(false)
  })

  test('rejects a message with a null byte', () => {
    expect(validateChatRequest({ message: 'a\u0000b' }).ok).toBe(false)
  })

  test('rejects an over-long working_directory', () => {
    const result = validateChatRequest({
      message: 'hello',
      working_directory: '/'.repeat(MAX_PATH_LENGTH + 1),
    })
    expect(result.ok).toBe(false)
  })

  test('rejects an over-long session_id', () => {
    const result = validateChatRequest({
      message: 'hello',
      session_id: 'a'.repeat(MAX_SESSION_ID_LENGTH + 1),
    })
    expect(result.ok).toBe(false)
  })

  test('rejects a session_id with invalid characters', () => {
    for (const bad of ['has space', 'semi;colon', 'slash/../etc', 'new\nline']) {
      expect(validateChatRequest({ message: 'hi', session_id: bad }).ok).toBe(false)
    }
  })
})

import { describe, test, expect } from 'bun:test'
import {
  assertValidSessionId,
  mapMessageToSDK,
  createEnvMutexForTesting,
} from '../../src/entrypoints/sdk/shared.js'

describe('assertValidSessionId', () => {
  test('accepts valid UUID v4', () => {
    expect(() => assertValidSessionId('00000000-0000-0000-0000-000000000000')).not.toThrow()
    expect(() => assertValidSessionId('550e8400-e29b-41d4-a716-446655440000')).not.toThrow()
  })

  test('rejects non-UUID string', () => {
    expect(() => assertValidSessionId('not-a-uuid')).toThrow('Invalid session ID')
  })

  test('rejects empty string', () => {
    expect(() => assertValidSessionId('')).toThrow('Invalid session ID')
  })

  test('rejects UUID with wrong format', () => {
    expect(() => assertValidSessionId('00000000-0000-0000-0000')).toThrow('Invalid session ID')
  })

  test('rejects path traversal attempts', () => {
    expect(() => assertValidSessionId('../../etc/passwd')).toThrow('Invalid session ID')
  })
})

describe('mapMessageToSDK', () => {
  test('preserves type field from message', () => {
    const result = mapMessageToSDK({ type: 'assistant', content: 'hello' })
    expect(result.type).toBe('assistant')
  })

  test('defaults to unknown when type is missing', () => {
    const result = mapMessageToSDK({ content: 'hello' })
    expect<string>(result.type).toBe('unknown')
  })

  test('spreads all fields through', () => {
    const msg = {
      type: 'result',
      session_id: 'test-123',
      subtype: 'success',
      cost_usd: 0.01,
    }
    const result = mapMessageToSDK(msg)
    expect((result as unknown as typeof msg).session_id).toBe('test-123')
    expect((result as unknown as typeof msg).subtype).toBe('success')
    expect((result as unknown as typeof msg).cost_usd).toBe(0.01)
  })

  test('preserves nested objects', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    }
    const result = mapMessageToSDK(msg)
    expect((result as unknown as typeof msg).message.content[0].text).toBe('Hello world')
  })

  test('throws TypeError for null input', () => {
    expect(() => mapMessageToSDK(null as unknown as Record<string, unknown>)).toThrow(TypeError)
    expect(() => mapMessageToSDK(null as unknown as Record<string, unknown>)).toThrow('expected non-null object')
  })

  test('throws TypeError for non-object input', () => {
    expect(() => mapMessageToSDK('string' as unknown as Record<string, unknown>)).toThrow(TypeError)
    expect(() => mapMessageToSDK(42 as unknown as Record<string, unknown>)).toThrow(TypeError)
  })

  test('throws TypeError for invalid type field', () => {
    expect(() => mapMessageToSDK({ type: 123 })).toThrow(TypeError)
    expect(() => mapMessageToSDK({ type: 123 })).toThrow("'type' field must be string")
  })
})

describe.serial('env mutex timeout', () => {
  test('acquireEnvMutex returns timeout result when mutex is locked', async () => {
    const { acquireEnvMutex, releaseEnvMutex } = createEnvMutexForTesting()
    // First acquire locks the mutex
    const firstResult = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(firstResult.acquired).toBe(true)

    // Second acquire with timeout should return timeout result
    try {
      const secondResult = await acquireEnvMutex({ timeoutMs: 100 })
      expect(secondResult.acquired).toBe(false)
      expect(secondResult.reason).toBe('timeout')
    } finally {
      releaseEnvMutex()
    }
  })

  test('acquireEnvMutex succeeds before timeout', async () => {
    const { acquireEnvMutex, releaseEnvMutex } = createEnvMutexForTesting()
    const firstResult = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(firstResult.acquired).toBe(true)

    // Release after 50ms
    setTimeout(releaseEnvMutex, 50)

    // Second acquire with 200ms timeout should succeed
    let acquiredSecond = false
    try {
      const result = await acquireEnvMutex({ timeoutMs: 200 })
      acquiredSecond = result.acquired
      expect(result.acquired).toBe(true)
    } finally {
      if (acquiredSecond) {
        releaseEnvMutex()
      }
    }
  })

  test('acquireEnvMutex without timeout waits indefinitely (default behavior)', async () => {
    const { acquireEnvMutex, releaseEnvMutex } = createEnvMutexForTesting()
    const firstResult = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(firstResult.acquired).toBe(true)

    // Release after short delay
    setTimeout(releaseEnvMutex, 50)

    // No timeout option - should wait and succeed
    let acquiredSecond = false
    try {
      const result = await acquireEnvMutex()
      acquiredSecond = result.acquired
      expect(result.acquired).toBe(true)
    } finally {
      if (acquiredSecond) {
        releaseEnvMutex()
      }
    }
  })

  test('mutex remains functional after timeout', async () => {
    const { acquireEnvMutex, releaseEnvMutex } = createEnvMutexForTesting()
    // First acquire locks it
    const firstResult = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(firstResult.acquired).toBe(true)

    try {
      // Second acquire with timeout fails
      const result2 = await acquireEnvMutex({ timeoutMs: 50 })
      expect(result2.acquired).toBe(false)
    } finally {
      // Release the first
      releaseEnvMutex()
    }

    // Third acquire should succeed (mutex not permanently locked)
    const result3 = await acquireEnvMutex({ timeoutMs: 100 })
    try {
      expect(result3.acquired).toBe(true)
    } finally {
      if (result3.acquired) {
        releaseEnvMutex()
      }
    }
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { discoverOidc } from './xaaIdpLogin.js'
import {
  shouldCompleteXaaIdpCallback,
  validateXaaIdpCallbackParams,
} from './xaaIdpCallback.js'

test('XAA IdP callback rejects error parameters before state validation can be bypassed', () => {
  const result = validateXaaIdpCallbackParams(
    {
      error: 'access_denied',
      error_description: 'denied by provider',
    },
    'expected-state',
  )

  assert.deepEqual(result, { type: 'state_mismatch' })
  assert.equal(shouldCompleteXaaIdpCallback(result), false)
})

test('XAA IdP callback accepts provider errors only when state matches', () => {
  const result = validateXaaIdpCallbackParams(
    {
      state: 'expected-state',
      error: 'access_denied',
      error_description: 'denied by provider',
    },
    'expected-state',
  )

  assert.deepEqual(result, {
    type: 'error',
    error: 'access_denied',
    errorDescription: 'denied by provider',
  })
  assert.equal(shouldCompleteXaaIdpCallback(result), true)
})

test('XAA IdP callback accepts authorization codes only when state matches', () => {
  assert.deepEqual(
    validateXaaIdpCallbackParams(
      {
        state: 'expected-state',
        code: 'auth-code',
      },
      'expected-state',
    ),
    { type: 'code', code: 'auth-code' },
  )

  assert.deepEqual(
    validateXaaIdpCallbackParams(
      {
        state: 'wrong-state',
        code: 'auth-code',
      },
      'expected-state',
    ),
    { type: 'state_mismatch' },
  )
})

test('discoverOidc aborts a pending discovery request', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let markFetchStarted!: () => void
  const fetchStarted = new Promise<void>(resolve => {
    markFetchStarted = resolve
  })

  globalThis.fetch = ((_input: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      markFetchStarted()
      const signal = init?.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    })) as typeof globalThis.fetch

  try {
    const discovery = discoverOidc(
      'https://idp.example.test',
      controller.signal,
    )
    await fetchStarted
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await assert.rejects(discovery, { name: 'AbortError' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

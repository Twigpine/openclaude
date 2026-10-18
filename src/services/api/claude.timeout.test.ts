import { afterEach, expect, test } from 'bun:test'
import { getNonstreamingFallbackTimeoutMs } from './claude.js'

const originalApiTimeoutMs = process.env.API_TIMEOUT_MS
const originalRemote = process.env.CLAUDE_CODE_REMOTE

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restore('API_TIMEOUT_MS', originalApiTimeoutMs)
  restore('CLAUDE_CODE_REMOTE', originalRemote)
})

// The non-streaming fallback previously read API_TIMEOUT_MS with a raw
// parseInt and returned the override whenever it was truthy, so a malformed
// value produced NaN and a negative value passed straight through. It now
// shares the validated parser, which must still preserve the context-specific
// defaults: 120s on remote (to stay under CCR's container idle-kill) and 300s
// otherwise.
test('non-streaming fallback keeps the local default without an override', () => {
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.API_TIMEOUT_MS
  expect(getNonstreamingFallbackTimeoutMs()).toBe(300_000)
})

test('non-streaming fallback keeps the remote default without an override', () => {
  process.env.CLAUDE_CODE_REMOTE = '1'
  delete process.env.API_TIMEOUT_MS
  expect(getNonstreamingFallbackTimeoutMs()).toBe(120_000)
})

test('non-streaming fallback rejects malformed and negative overrides', () => {
  for (const invalid of ['not-a-number', '-1', '0', '1.5', '25ms', '']) {
    delete process.env.CLAUDE_CODE_REMOTE
    process.env.API_TIMEOUT_MS = invalid
    expect(getNonstreamingFallbackTimeoutMs()).toBe(300_000)

    process.env.CLAUDE_CODE_REMOTE = '1'
    expect(getNonstreamingFallbackTimeoutMs()).toBe(120_000)
  }
})

test('non-streaming fallback honors a valid override in both contexts', () => {
  process.env.API_TIMEOUT_MS = '45000'
  delete process.env.CLAUDE_CODE_REMOTE
  expect(getNonstreamingFallbackTimeoutMs()).toBe(45_000)

  process.env.CLAUDE_CODE_REMOTE = '1'
  expect(getNonstreamingFallbackTimeoutMs()).toBe(45_000)
})

test('non-streaming fallback clamps an oversized override', () => {
  process.env.API_TIMEOUT_MS = '3000000000'
  delete process.env.CLAUDE_CODE_REMOTE
  expect(getNonstreamingFallbackTimeoutMs()).toBe(2_147_483_647)
})

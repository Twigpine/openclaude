import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, expect, test } from 'bun:test'

import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  classifyAPIError,
  getAssistantMessageFromError,
  OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE,
  OPENCODE_GO_USAGE_LIMIT_ERROR_MESSAGE,
} from './errors.js'
import { shouldRetry } from './withRetry.js'

function getFirstText(message: ReturnType<typeof getAssistantMessageFromError>): string {
  const first = message.message.content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) {
    return ''
  }
  return typeof first.text === 'string' ? first.text : ''
}

const originalBaseUrl = process.env.OPENAI_BASE_URL
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-opencode-go-error-test-'))
  setClaudeConfigHomeDirForTesting(tempDir)
})

afterEach(() => {
  setClaudeConfigHomeDirForTesting(undefined)
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
  if (originalBaseUrl === undefined) {
    delete process.env.OPENAI_BASE_URL
  } else {
    process.env.OPENAI_BASE_URL = originalBaseUrl
  }
})

function makeGoError(body: string, headers?: Record<string, string>): APIError {
  const h = new Headers({
    'x-opencode-request-url': 'https://opencode.ai/zen/go/v1/messages',
    ...(headers ?? {}),
  })
  return APIError.generate(429, undefined, body, h)
}

test('FreeUsageLimitError surfaces the free-tier upgrade message', () => {
  const error = makeGoError(
    JSON.stringify({
      error: {
        type: 'FreeUsageLimitError',
        message: 'free usage limit reached',
      },
    }),
  )
  const message = getAssistantMessageFromError(error, 'glm-4.6')
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  expect(text).toBe(OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE)
  expect(text).toContain('Subscribe at https://opencode.ai/go')
})

test('GoUsageLimitError surfaces the subscription message with reset and workspace', () => {
  const error = makeGoError(
    JSON.stringify({
      error: {
        type: 'GoUsageLimitError',
        message: 'go subscription limit reached',
        limitName: 'weekly',
        workspace: 'euxaristia-personal',
      },
    }),
    { 'retry-after': '172800' }, // 2 days
  )
  const message = getAssistantMessageFromError(error, 'glm-4.6')
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  expect(text).toContain(OPENCODE_GO_USAGE_LIMIT_ERROR_MESSAGE)
  expect(text).toContain('Resets in 2d')
  expect(text).toContain('Workspace: euxaristia-personal')
  expect(text).toContain('Limit: weekly')
})

test('GoUsageLimitError without retry-after omits reset hint', () => {
  const error = makeGoError(
    JSON.stringify({
      error: {
        type: 'GoUsageLimitError',
        limitName: 'rolling',
        workspace: 'default',
      },
    }),
  )
  const text = getFirstText(getAssistantMessageFromError(error, 'glm-4.6'))

  expect(text).toContain(OPENCODE_GO_USAGE_LIMIT_ERROR_MESSAGE)
  expect(text).not.toContain('Resets in')
  // default workspace is not surfaced to reduce noise
  expect(text).not.toContain('Workspace:')
})

test('GoUsageLimitError reset duration formats hours and minutes', () => {
  const error = makeGoError(
    JSON.stringify({
      error: { type: 'GoUsageLimitError', limitName: 'daily', workspace: 'default' },
    }),
    { 'retry-after': '7560' }, // 2h 6m
  )
  const text = getFirstText(getAssistantMessageFromError(error, 'glm-4.6'))
  expect(text).toContain('Resets in 2h 6m')
})

test('falls back to OPENAI_BASE_URL env check when header is missing', () => {
  process.env.OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1'
  const error = APIError.generate(
    429,
    undefined,
    JSON.stringify({
      error: { type: 'FreeUsageLimitError', message: 'free exhausted' },
    }),
    new Headers(),
  )
  const text = getFirstText(getAssistantMessageFromError(error, 'glm-4.6'))
  expect(text).toBe(OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE)
})

test('OpenAI compatibility quota marker does not hide OpenCode Go message', () => {
  const error = APIError.generate(
    429,
    undefined,
    'OpenAI API error 429: {"type":"FreeUsageLimitError","message":"free usage limit reached"} [openai_category=quota_exhausted,host=opencode.ai] Hint: Provider quota or usage allotment has run out.',
    new Headers({ 'x-opencode-request-url': 'https://opencode.ai/zen/go/v1/messages' }),
  )
  const text = getFirstText(getAssistantMessageFromError(error, 'glm-4.6'))

  expect(text).toBe(OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE)
})

test('non-opencode-go 429 with similar body is NOT mapped to opencode-go message', () => {
  // Same error body shape but no opencode.ai/zen/go URL anywhere
  const savedBaseUrl = process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_BASE_URL
  try {
    const error = APIError.generate(
      429,
      undefined,
      JSON.stringify({
        error: { type: 'FreeUsageLimitError', message: 'free exhausted' },
      }),
      new Headers({ 'x-opencode-request-url': 'https://api.openai.com/v1/messages' }),
    )
    const text = getFirstText(getAssistantMessageFromError(error, 'glm-4.6'))
    expect(text).not.toContain('OpenCode Go')
  } finally {
    if (savedBaseUrl !== undefined) {
      process.env.OPENAI_BASE_URL = savedBaseUrl
    }
  }
})

test('classifyAPIError returns opencode_go_quota_exhausted for GoUsageLimitError', () => {
  const error = makeGoError(
    JSON.stringify({ error: { type: 'GoUsageLimitError' } }),
  )
  expect(classifyAPIError(error)).toBe('opencode_go_quota_exhausted')
})

test('classifyAPIError returns opencode_go_quota_exhausted for FreeUsageLimitError', () => {
  const error = makeGoError(
    JSON.stringify({ error: { type: 'FreeUsageLimitError' } }),
  )
  expect(classifyAPIError(error)).toBe('opencode_go_quota_exhausted')
})

test('classifyAPIError returns rate_limit for generic opencode-go 429', () => {
  const error = makeGoError(JSON.stringify({ error: { message: 'slow down' } }))
  expect(classifyAPIError(error)).toBe('rate_limit')
})

test('shouldRetry returns false for OpenCode Go usage limits', () => {
  const freeError = makeGoError(
    JSON.stringify({ error: { type: 'FreeUsageLimitError' } }),
  )
  expect(shouldRetry(freeError, false)).toBe(false)

  const goError = makeGoError(
    JSON.stringify({ error: { type: 'GoUsageLimitError' } }),
  )
  expect(shouldRetry(goError, false)).toBe(false)
})

test('shouldRetry returns true for similar body on non-OpenCode 429', () => {
  const savedBaseUrl = process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_BASE_URL
  try {
    const error = APIError.generate(
      429,
      undefined,
      JSON.stringify({ error: { type: 'FreeUsageLimitError' } }),
      new Headers({ 'x-opencode-request-url': 'https://api.openai.com/v1/messages' }),
    )
    expect(shouldRetry(error, false)).toBe(true)
  } finally {
    if (savedBaseUrl !== undefined) {
      process.env.OPENAI_BASE_URL = savedBaseUrl
    }
  }
})

test('precedence: when request header points to non-OpenCode, environment variable is ignored', () => {
  // Set env var to OpenCode Go url (simulating stale config)
  process.env.OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1'

  const error = APIError.generate(
    429,
    undefined,
    JSON.stringify({
      error: { type: 'FreeUsageLimitError', message: 'free exhausted' },
    }),
    new Headers({ 'x-opencode-request-url': 'https://api.openai.com/v1/messages' }),
  )

  // Message should NOT be OpenCode Go message
  const text = getFirstText(getAssistantMessageFromError(error, 'glm-4.6'))
  expect(text).not.toContain('OpenCode Go')

  // Retry gate should allow retry
  expect(shouldRetry(error, false)).toBe(true)
})

test('retry regression: FreeUsageLimitError and GoUsageLimitError are not retried on OpenCode Go', () => {
  // 1. With authoritative header pointing to OpenCode Go
  const errorHeaderFree = APIError.generate(
    429,
    undefined,
    JSON.stringify({ error: { type: 'FreeUsageLimitError' } }),
    new Headers({ 'x-opencode-request-url': 'https://opencode.ai/zen/go/v1/messages' }),
  )
  expect(shouldRetry(errorHeaderFree, false)).toBe(false)

  const errorHeaderGo = APIError.generate(
    429,
    undefined,
    JSON.stringify({ error: { type: 'GoUsageLimitError' } }),
    new Headers({ 'x-opencode-request-url': 'https://opencode.ai/zen/go/v1/messages' }),
  )
  expect(shouldRetry(errorHeaderGo, false)).toBe(false)

  // 2. With header absent, falling back to environment variable pointing to OpenCode Go
  const originalEnv = process.env.OPENAI_BASE_URL
  try {
    process.env.OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1'

    const errorEnvFree = APIError.generate(
      429,
      undefined,
      JSON.stringify({ error: { type: 'FreeUsageLimitError' } }),
      new Headers(),
    )
    expect(shouldRetry(errorEnvFree, false)).toBe(false)

    const errorEnvGo = APIError.generate(
      429,
      undefined,
      JSON.stringify({ error: { type: 'GoUsageLimitError' } }),
      new Headers(),
    )
    expect(shouldRetry(errorEnvGo, false)).toBe(false)
  } finally {
    process.env.OPENAI_BASE_URL = originalEnv
  }
})

test('retry regression: non-OpenCode 429 errors with similar body markers are retried', () => {
  // 1. Header is present but points to non-OpenCode
  const errorHeaderFree = APIError.generate(
    429,
    undefined,
    JSON.stringify({ error: { type: 'FreeUsageLimitError' } }),
    new Headers({ 'x-opencode-request-url': 'https://api.openai.com/v1/messages' }),
  )
  expect(shouldRetry(errorHeaderFree, false)).toBe(true)

  const errorHeaderGo = APIError.generate(
    429,
    undefined,
    JSON.stringify({ error: { type: 'GoUsageLimitError' } }),
    new Headers({ 'x-opencode-request-url': 'https://api.openai.com/v1/messages' }),
  )
  expect(shouldRetry(errorHeaderGo, false)).toBe(true)

  // 2. Header is absent, and environment variable does not point to OpenCode Go
  const originalEnv = process.env.OPENAI_BASE_URL
  try {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

    const errorEnvFree = APIError.generate(
      429,
      undefined,
      JSON.stringify({ error: { type: 'FreeUsageLimitError' } }),
      new Headers(),
    )
    expect(shouldRetry(errorEnvFree, false)).toBe(true)

    const errorEnvGo = APIError.generate(
      429,
      undefined,
      JSON.stringify({ error: { type: 'GoUsageLimitError' } }),
      new Headers(),
    )
    expect(shouldRetry(errorEnvGo, false)).toBe(true)
  } finally {
    process.env.OPENAI_BASE_URL = originalEnv
  }
})

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

beforeEach(async () => {
  await acquireSharedMutationLock('services/oauth/auth-code-listener.analytics.test.ts')
})

afterEach(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

test('custom error responses log the error redirect analytics event', async () => {
  const events: Array<{
    name: string
    metadata: Record<string, boolean | number | undefined>
  }> = []

  mock.module('src/services/analytics/index.js', () => ({
    logEvent: (
      name: string,
      metadata: Record<string, boolean | number | undefined>,
    ) => {
      events.push({ name, metadata })
    },
  }))

  const { AuthCodeListener } = await import(
    `./auth-code-listener.js?ts=${Date.now()}-${Math.random()}`
  )
  const listener = new AuthCodeListener('/callback')
  const response = {
    writeHead: () => {},
    end: () => {},
  }

  ;(listener as any).pendingResponse = response

  listener.handleErrorRedirect(res => {
    res.writeHead(400, {
      'Content-Type': 'text/plain; charset=utf-8',
    })
    res.end('cancelled')
  })

  expect(events).toEqual([
    {
      name: 'tengu_oauth_automatic_redirect_error',
      metadata: { custom_handler: true },
    },
  ])
})

test('custom handlers that do not end the response are closed automatically and still log analytics', async () => {
  const events: Array<{
    name: string
    metadata: Record<string, boolean | number | undefined>
  }> = []
  const response = {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    writeHead: () => {
      response.headersSent = true
    },
    end: () => {
      response.writableEnded = true
    },
  }

  mock.module('src/services/analytics/index.js', () => ({
    logEvent: (
      name: string,
      metadata: Record<string, boolean | number | undefined>,
    ) => {
      events.push({ name, metadata })
    },
  }))

  mock.module('../../utils/log.js', () => ({
    logError: () => {},
  }))

  const { AuthCodeListener } = await import(
    `./auth-code-listener.js?ts=${Date.now()}-${Math.random()}`
  )
  const listener = new AuthCodeListener('/callback')

  ;(listener as any).pendingResponse = response

  listener.handleErrorRedirect(res => {
    res.writeHead(400, {
      'Content-Type': 'text/plain; charset=utf-8',
    })
  })

  expect(response.writableEnded).toBe(true)
  expect((listener as any).pendingResponse).toBeNull()
  expect(events).toEqual([
    {
      name: 'tengu_oauth_automatic_redirect_error',
      metadata: { custom_handler: true },
    },
  ])
})

test('custom handlers that throw are logged, converted to a fallback response, and do not log analytics', async () => {
  const events: Array<{
    name: string
    metadata: Record<string, boolean | number | undefined>
  }> = []
  const loggedErrors: unknown[] = []
  const response = {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    body: '',
    writeHead: (statusCode: number) => {
      response.headersSent = true
      response.statusCode = statusCode
    },
    end: (body = '') => {
      response.writableEnded = true
      response.body = body
    },
  }

  mock.module('src/services/analytics/index.js', () => ({
    logEvent: (
      name: string,
      metadata: Record<string, boolean | number | undefined>,
    ) => {
      events.push({ name, metadata })
    },
  }))

  mock.module('../../utils/log.js', () => ({
    logError: (error: unknown) => {
      loggedErrors.push(error)
    },
  }))

  const { AuthCodeListener } = await import(
    `./auth-code-listener.js?ts=${Date.now()}-${Math.random()}`
  )
  const listener = new AuthCodeListener('/callback')

  ;(listener as any).pendingResponse = response

  listener.handleErrorRedirect(() => {
    throw new Error('handler exploded')
  })

  expect(response.statusCode).toBe(500)
  expect(response.body).toBe('Authentication redirect failed')
  expect(response.writableEnded).toBe(true)
  expect((listener as any).pendingResponse).toBeNull()
  expect(loggedErrors).toHaveLength(1)
  expect(events).toEqual([])
})

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

import {
  DEFAULT_GITHUB_DEVICE_SCOPE,
  requestDeviceCode,
} from './deviceFlow.js'

async function importFreshModule() {
  mock.restore()
  return import(`./deviceFlow.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('services/github/deviceFlow.test.ts')
})

afterEach(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('GitHub Enterprise auth endpoints', () => {
  test('normalize path-bearing Enterprise URLs to the instance origin', async () => {
    const {
      getGithubEnterpriseAccessTokenUrl,
      getGithubEnterpriseCopilotTokenUrl,
      getGithubEnterpriseDeviceCodeUrl,
    } = await importFreshModule()
    const gheUrl = 'https://github.mycompany.com/api/copilot/'

    expect(getGithubEnterpriseDeviceCodeUrl(gheUrl)).toBe(
      'https://github.mycompany.com/login/device/code',
    )
    expect(getGithubEnterpriseAccessTokenUrl(gheUrl)).toBe(
      'https://github.mycompany.com/login/oauth/access_token',
    )
    expect(getGithubEnterpriseCopilotTokenUrl(gheUrl)).toBe(
      'https://github.mycompany.com/api/copilot_internal/v2/token',
    )
  })
})

describe('requestDeviceCode', () => {
  test('parses successful device code response', async () => {
    const { requestDeviceCode } = await importFreshModule()

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: 'abc',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 600,
            interval: 5,
          }),
          { status: 200 },
        ),
      ),
    )

    const r = await requestDeviceCode({
      clientId: 'test-client',
      fetchImpl,
    })
    expect(r.device_code).toBe('abc')
    expect(r.user_code).toBe('ABCD-1234')
    expect(r.verification_uri).toBe('https://github.com/login/device')
    expect(r.expires_in).toBe(600)
    expect(r.interval).toBe(5)
  })

  test('uses normalized Enterprise endpoint when gheUrl is provided', async () => {
    const { requestDeviceCode } = await importFreshModule()
    let capturedUrl = ''
    const fetchImpl = mock((url: RequestInfo | URL) => {
      capturedUrl = String(url)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: 'abc',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.mycompany.com/login/device',
          }),
          { status: 200 },
        ),
      )
    })

    await requestDeviceCode({
      clientId: 'test-client',
      fetchImpl,
      gheUrl: 'https://github.mycompany.com/api/copilot/',
    })

    expect(capturedUrl).toBe(
      'https://github.mycompany.com/login/device/code',
    )
  })

  test('throws on HTTP error', async () => {
    const { requestDeviceCode, GitHubDeviceFlowError } =
      await importFreshModule()

    const fetchImpl = mock(() =>
      Promise.resolve(new Response('bad', { status: 500 })),
    )
    await expect(
      requestDeviceCode({ clientId: 'x', fetchImpl }),
    ).rejects.toThrow(GitHubDeviceFlowError)
  })

  test('uses OAuth-safe default scope', async () => {
    let capturedScope = ''
    const fetchImpl = mock((_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body
      if (body instanceof URLSearchParams) {
        capturedScope = body.get('scope') ?? ''
      } else {
        capturedScope = new URLSearchParams(String(body ?? '')).get('scope') ?? ''
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: 'abc',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
          }),
          { status: 200 },
        ),
      )
    })

    await requestDeviceCode({ clientId: 'test-client', fetchImpl })
    expect(capturedScope).toBe(DEFAULT_GITHUB_DEVICE_SCOPE)
    expect(capturedScope).toBe('read:user')
  })

  test('retries with OAuth-safe scope on invalid_scope', async () => {
    const scopesSeen: string[] = []
    let callCount = 0

    const fetchImpl = mock((_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body
      const scope =
        body instanceof URLSearchParams
          ? body.get('scope') ?? ''
          : new URLSearchParams(String(body ?? '')).get('scope') ?? ''
      scopesSeen.push(scope)
      callCount++

      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'invalid_scope',
              error_description: 'invalid models scope',
            }),
            { status: 400 },
          ),
        )
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: 'abc',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
          }),
          { status: 200 },
        ),
      )
    })

    const result = await requestDeviceCode({
      clientId: 'test-client',
      scope: 'read:user,models:read',
      fetchImpl,
    })

    expect(result.device_code).toBe('abc')
    expect(callCount).toBe(2)
    expect(scopesSeen).toEqual(['read:user,models:read', 'read:user'])
  })
})

describe('pollAccessToken', () => {
  test('returns token when GitHub responds with access_token immediately', async () => {
    const { pollAccessToken } = await importFreshModule()

    let calls = 0
    const fetchImpl = mock(() => {
      calls++
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'tok-xyz' }), {
          status: 200,
        }),
      )
    })

    const token = await pollAccessToken('dev-code', {
      clientId: 'cid',
      fetchImpl,
    })
    expect(token).toBe('tok-xyz')
    expect(calls).toBe(1)
  })

  test('throws on access_denied', async () => {
    const { pollAccessToken } = await importFreshModule()

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'access_denied' }), {
          status: 200,
        }),
      ),
    )
    await expect(
      pollAccessToken('dc', {
        clientId: 'c',
        fetchImpl,
      }),
    ).rejects.toThrow(/denied/)
  })
})

describe('exchangeForCopilotToken', () => {
  test('parses successful Copilot token response', async () => {
    const { exchangeForCopilotToken } = await importFreshModule()

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            token: 'copilot-token-xyz',
            expires_at: 1700000000,
            refresh_in: 3600,
            endpoints: {
              api: 'https://api.githubcopilot.com',
            },
          }),
          { status: 200 },
        ),
      ),
    )

    const result = await exchangeForCopilotToken('oauth-token', fetchImpl)
    expect(result.token).toBe('copilot-token-xyz')
    expect(result.expires_at).toBe(1700000000)
    expect(result.refresh_in).toBe(3600)
    expect(result.endpoints.api).toBe('https://api.githubcopilot.com')
  })

  test('throws on HTTP error', async () => {
    const { exchangeForCopilotToken, GitHubDeviceFlowError } =
      await importFreshModule()

    const fetchImpl = mock(() =>
      Promise.resolve(new Response('unauthorized', { status: 401 })),
    )
    await expect(
      exchangeForCopilotToken('bad-token', fetchImpl),
    ).rejects.toThrow(GitHubDeviceFlowError)
  })

  test('throws on malformed response', async () => {
    const { exchangeForCopilotToken } = await importFreshModule()

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ invalid: 'data' }), { status: 200 }),
      ),
    )
    await expect(
      exchangeForCopilotToken('oauth-token', fetchImpl),
    ).rejects.toThrow(/Malformed/)
  })
})

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  beginAimlapiEmailOnboarding,
  completeAimlapiCodeSignIn,
  validateAimlapiApiKey,
} from './onboarding.js'
import {
  acquireAimlapiSignInKeyLeaseAsync,
  loadAimlapiSignInKey,
  saveAimlapiSignInKey,
} from './topupState.js'

const originalFetch = globalThis.fetch
const originalEnv = {
  AIMLAPI_AUTH_URL: process.env.AIMLAPI_AUTH_URL,
  AIMLAPI_APP_URL: process.env.AIMLAPI_APP_URL,
  AIMLAPI_INFERENCE_URL: process.env.AIMLAPI_INFERENCE_URL,
}

// completeAimlapiCodeSignIn persists the sign-in key cache/lease to disk (see
// mintOrAdoptSignInKey), so tests need an isolated config dir per test —
// otherwise they'd read/write the real ~/.openclaude and bleed into each other.
let configDirectory: string

beforeEach(() => {
  configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-onboarding-'))
  setClaudeConfigHomeDirForTesting(configDirectory)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setClaudeConfigHomeDirForTesting(undefined)
  rmSync(configDirectory, { force: true, recursive: true })
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status })
}

// Permission bits don't restrict a root process (common in CI containers), so
// a chmod-based unreadable-file test would spuriously pass without exercising
// anything. Detect that case and skip rather than assert on it.
function readableDespiteNoPermissions(path: string): boolean {
  if (process.platform === 'win32') return true
  try {
    readFileSync(path, 'utf8')
    return true
  } catch {
    return false
  }
}

test('existing account onboarding sends a code, creates a key, and reports low balance', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method} ${url}`)
    if (url.endsWith('/v1/auth/account')) return response({ action: 'sign-in' })
    if (url.endsWith('/v1/auth/sign-in/code')) return new Response('', { status: 204 })
    if (url.endsWith('/code/verify')) return response({ token: 'session', exp: 1 })
    if (url.endsWith('/v1/keys')) return response({ key: 'key_test', id: 'id_test' })
    if (url.endsWith('/billing/balance')) {
      return response({ balance: 5, lowBalance: true, lowBalanceThreshold: 20 })
    }
    return response({}, 404)
  }) as unknown as typeof fetch

  expect(await beginAimlapiEmailOnboarding('user@example.com')).toEqual({
    action: 'code-sent',
  })
  expect(await completeAimlapiCodeSignIn('user@example.com', '123456')).toEqual({
    sessionToken: 'session',
    apiKey: 'key_test',
    apiKeyId: 'id_test',
    balanceStatus: 'confirmed',
    lowBalance: true,
  })
  expect(calls).toEqual([
    'PATCH https://auth.example.test/v1/auth/account',
    'POST https://auth.example.test/v1/auth/sign-in/code',
    'POST https://auth.example.test/v1/auth/sign-in/code/verify',
    'POST https://app.example.test/v1/keys',
    'GET https://api.example.test/v1/billing/balance',
  ])
})

test('balance failures preserve the issued key without marking it ready', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/code/verify')) return response({ token: 'session', exp: 1 })
    if (url.endsWith('/v1/keys')) return response({ key: 'key_test', id: 'id_test' })
    return response({ error: 'unavailable' }, 503)
  }) as unknown as typeof fetch

  const result = await completeAimlapiCodeSignIn('user@example.com', '123456')
  expect(result).toEqual({
    sessionToken: 'session',
    apiKey: 'key_test',
    apiKeyId: 'id_test',
    balanceStatus: 'unknown',
    balanceError: 'GET https://api.example.test -> 503',
  })
  expect(result).not.toHaveProperty('lowBalance')
})

test('an aborted balance read after minting still returns the issued key', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const controller = new AbortController()
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/code/verify')) return response({ token: 'session', exp: 1 })
    if (url.endsWith('/v1/keys')) return response({ key: 'minted_key', id: 'minted_id' })
    if (url.endsWith('/billing/balance')) {
      // Abort mid-read, after the key has already been minted.
      controller.abort()
      throw new Error('balance aborted')
    }
    return response({}, 404)
  }) as unknown as typeof fetch

  const result = await completeAimlapiCodeSignIn(
    'user@example.com',
    '123456',
    controller.signal,
  )

  // The mint is irreversible, so an aborted balance read must still surface the
  // key (as unknown balance) rather than rethrow and orphan a paid credential.
  expect(result.apiKey).toBe('minted_key')
  expect(result.apiKeyId).toBe('minted_id')
  expect(result.balanceStatus).toBe('unknown')
  expect(result).not.toHaveProperty('lowBalance')
  // Exactly one mint: the abort must not trigger a second key on the next run.
  expect(calls.filter(url => url.endsWith('/v1/keys')).length).toBe(1)
})

test('new account onboarding returns a passwordless session', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    return url.endsWith('/passwordless')
      ? response({ token: 'new-session', exp: 1 })
      : response({ action: 'sign-up' })
  }) as unknown as typeof fetch

  expect(await beginAimlapiEmailOnboarding('new@example.com')).toEqual({
    action: 'new-account',
    sessionToken: 'new-session',
  })
})

test('existing API key validation uses the balance endpoint', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.example.test/v1/billing/balance')
    expect(init?.method).toBe('GET')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key_test')
    return response({ balance: 25, lowBalance: false, lowBalanceThreshold: 20 })
  }) as unknown as typeof fetch

  expect(await validateAimlapiApiKey(' key_test ')).toEqual({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  })
})

test('existing API key validation can pin the validated endpoint', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://override.example.test/v1'
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    expect(String(input)).toBe('https://api.aimlapi.com/v1/billing/balance')
    return response({ balance: 25, lowBalance: false, lowBalanceThreshold: 20 })
  }) as unknown as typeof fetch

  await validateAimlapiApiKey(
    'key_test',
    undefined,
    'https://api.aimlapi.com/v1',
  )
})

test('unknown account actions are rejected instead of signing up', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  globalThis.fetch = mock(async () => response({ action: 'migrate' })) as unknown as typeof fetch
  // The client validates the account action at the boundary and fails closed on
  // an unknown one, so onboarding never reaches its own unsupported-action guard.
  await expect(beginAimlapiEmailOnboarding('user@example.com')).rejects.toThrow(
    /invalid account response/i,
  )
})

test('completeAimlapiCodeSignIn reuses a supplied key instead of minting a new one', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/code/verify')) return response({ token: 'bearer', exp: 1 })
    if (url.endsWith('/billing/balance')) {
      return response({ balance: 100, lowBalance: false, lowBalanceThreshold: 20 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const result = await completeAimlapiCodeSignIn(
    'user@example.com',
    '123456',
    undefined,
    'https://api.example.test/v1',
    { apiKey: 'existing-key', apiKeyId: 'existing-id' },
  )

  expect(result.apiKey).toBe('existing-key')
  expect(result.apiKeyId).toBe('existing-id')
  // No key was minted; only verify + balance were called.
  expect(calls.some(call => call.endsWith('/v1/keys'))).toBe(false)
})

test('a revoked cached key is invalidated and replaced with one freshly minted key', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  // Seed the on-disk cache the way a real caller (ProviderManager's
  // loadAimlapiSignInKey) would, so this proves the entry is actually
  // invalidated on disk, not just bypassed in memory.
  saveAimlapiSignInKey('user@example.com', 'revoked-key', 'revoked-id')

  let keyMints = 0
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/code/verify')) return response({ token: 'bearer', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      keyMints += 1
      return response({ key: 'replacement-key', id: 'replacement-id' })
    }
    if (url.endsWith('/billing/balance')) {
      // The cached key was revoked/deleted server-side — a definite
      // rejection, not a transient/ambiguous failure.
      return response({ error: 'invalid api key' }, 401)
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const result = await completeAimlapiCodeSignIn(
    'user@example.com',
    '123456',
    undefined,
    'https://api.example.test/v1',
    { apiKey: 'revoked-key', apiKeyId: 'revoked-id' },
  )

  // Recovered with exactly one replacement key, not the dead one.
  expect(keyMints).toBe(1)
  expect(result.apiKey).toBe('replacement-key')
  expect(result.apiKeyId).toBe('replacement-id')
  expect(result.balanceStatus).toBe('unknown')

  // The cache reflects the replacement, not the revoked key — a future
  // sign-in adopts it instead of looping on the dead credential forever.
  expect(loadAimlapiSignInKey('user@example.com')).toEqual({
    apiKey: 'replacement-key',
    apiKeyId: 'replacement-id',
  })
})

test('two concurrent sign-ins for the same email never both mint a key', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  let keyMints = 0
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/code/verify')) return response({ token: 'bearer', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      keyMints += 1
      // Hold the POST open long enough for the concurrent call to reach its
      // own lease-acquire attempt and observe this one still in flight
      // (status 'held'), instead of racing it to a second POST.
      await new Promise(resolve => setTimeout(resolve, 200))
      return response({ key: `minted-key-${keyMints}`, id: `minted-id-${keyMints}` })
    }
    if (url.endsWith('/billing/balance')) {
      return response({ balance: 100, lowBalance: false, lowBalanceThreshold: 20 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const runOnce = () =>
    completeAimlapiCodeSignIn('user@example.com', '123456', undefined, 'https://api.example.test/v1')

  const [resultA, resultB] = await Promise.all([runOnce(), runOnce()])

  // The core guarantee: exactly one POST /v1/keys happened, not two — the
  // loser's lease-acquire attempt found the winner's lease held and adopted
  // its cached key instead of minting (and orphaning) its own.
  expect(keyMints).toBe(1)
  expect(resultA.apiKey).toBe('minted-key-1')
  expect(resultA.apiKeyId).toBe('minted-id-1')
  expect(resultB.apiKey).toBe('minted-key-1')
  expect(resultB.apiKeyId).toBe('minted-id-1')
}, 10_000)

test('a 2xx createKey response with an unusable body holds the sign-in lease instead of allowing an immediate re-mint', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'

  // POST /v1/keys is non-idempotent: a 2xx status means the server received
  // and likely committed the request, even when the body that would have
  // confirmed it is unusable. Each of these must be held ambiguous, not
  // treated as proof nothing was created.
  const malformedResponses: Record<string, () => Response> = {
    empty: () => new Response('', { status: 200 }),
    'non-JSON': () => new Response('not json', { status: 200 }),
    oversized: () => new Response('x'.repeat((1 << 20) + 1), { status: 200 }),
    'missing id': () => new Response(JSON.stringify({ key: 'k_test' }), { status: 200 }),
    'missing key': () => new Response(JSON.stringify({ id: 'id_test' }), { status: 200 }),
  }

  for (const [label, makeResponse] of Object.entries(malformedResponses)) {
    // Lowercase: the lease file's keys are normalized (case-insensitive)
    // email, so a mixed-case label here (e.g. "non-JSON") would otherwise
    // look up the wrong key below and fail regardless of the real behavior.
    const email = `user-${label.toLowerCase().replace(/\s+/g, '-')}@example.com`
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/code/verify')) return response({ token: 'bearer', exp: 1 })
      if (url.endsWith('/v1/keys')) return makeResponse()
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch

    await expect(
      completeAimlapiCodeSignIn(email, '123456', undefined, 'https://api.example.test/v1'),
    ).rejects.toThrow()

    const leasePath = join(configDirectory, 'aimlapi-signin-lease.json')
    const lease = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<
      string,
      { owner?: string; at?: number }
    >
    expect(lease[email]?.owner, `lease held after a ${label} 2xx response`).toBeTruthy()
    // No key was ever cached for this ambiguous outcome — a later resolution
    // (once the lease goes stale, or the real outcome is confirmed some other
    // way) must still be able to adopt/recover it, not find a wrong cache entry.
    expect(loadAimlapiSignInKey(email)).toBeNull()
  }
})

test('a slow createKey refreshes the sign-in lease before the cache save lands', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const leasePath = join(configDirectory, 'aimlapi-signin-lease.json')

  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/code/verify')) return response({ token: 'bearer', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      // Simulate createKey having taken nearly the full 60s request timeout:
      // by the time it resolves, the lease is already right up against the
      // 75s stale threshold, with the cache write still to come.
      const store = JSON.parse(readFileSync(leasePath, 'utf8'))
      store['user@example.com'].at = Date.now() - 74_000
      writeFileSync(leasePath, JSON.stringify(store))
      return response({ key: 'minted-key', id: 'minted-id' })
    }
    if (url.endsWith('/billing/balance')) {
      return response({ balance: 100, lowBalance: false, lowBalanceThreshold: 20 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  await completeAimlapiCodeSignIn(
    'user@example.com',
    '123456',
    undefined,
    'https://api.example.test/v1',
  )

  // The commit at the end of a successful mint retires the lease outright
  // (see commitAimlapiSignInKeyAsync) rather than merely refreshing it, so a
  // near-stale timestamp at commit time must not stop that retirement — the
  // refresh's own effect (keeping a still-in-flight lease from going stale
  // mid-wait) is covered directly by the isolated topupState lease test this
  // one closes the gap for.
  expect(existsSync(leasePath)).toBe(false)
})

test('a cache-commit failure right after a successful mint stops the flow instead of stranding the key', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'

  // A file (not a directory) at the path the config dir is switched to right
  // as createKey succeeds — forces the post-mint commit's own mkdirSync
  // (ensureOwnerOnlyDir) to fail with ENOTDIR deterministically and
  // portably, simulating a real lock/permission/IO-class failure without
  // relying on OS-specific permission semantics.
  const brokenParent = join(configDirectory, 'not-a-directory')
  writeFileSync(brokenParent, '')
  const brokenConfigDir = join(brokenParent, 'nested')

  let keyMints = 0
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/code/verify')) return response({ token: 'bearer', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      keyMints += 1
      // The key is minted server-side — genuinely successful — but the
      // config dir is switched to a broken path right before returning, so
      // the commit that follows fails deterministically.
      setClaudeConfigHomeDirForTesting(brokenConfigDir)
      return response({ key: 'minted-key', id: 'minted-id' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const error = await completeAimlapiCodeSignIn(
    'user@example.com',
    '123456',
    undefined,
    'https://api.example.test/v1',
  ).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toMatch(/recovery receipt could not be saved/i)
  // The issued key id is the recovery handle this error exists to surface —
  // without it, the dashboard-rotation guidance has nothing to point the
  // user at, so the message must name it, not just describe the failure.
  expect(message).toContain('minted-id')
  // Exactly one createKey call: the flow stopped instead of retrying
  // blindly within the same attempt.
  expect(keyMints).toBe(1)

  // Restore the good directory to inspect what was actually left behind —
  // the lease was acquired in the ORIGINAL directory, before the switch.
  setClaudeConfigHomeDirForTesting(configDirectory)
  expect(loadAimlapiSignInKey('user@example.com')).toBeNull()

  // The lease must still be held — releasing it (or letting a peer reclaim
  // it) here would let a retry mint (and orphan) a second key while this
  // one's receipt remains unresolved.
  const retryLease = await acquireAimlapiSignInKeyLeaseAsync('user@example.com', 'retry-owner')
  expect(retryLease.status).toBe('held')
})

function mockVerifyAndKeyMintCounter(keyMints: { count: number }): typeof fetch {
  return mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/code/verify')) return response({ token: 'bearer', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      keyMints.count += 1
      return response({ key: 'new-key', id: 'new-id' })
    }
    if (url.endsWith('/billing/balance')) {
      return response({ balance: 100, lowBalance: false, lowBalanceThreshold: 20 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch
}

test('an unreadable sign-in key cache fails closed instead of minting a fresh key', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const cachePath = join(configDirectory, 'aimlapi-signin-key.json')
  writeFileSync(
    cachePath,
    JSON.stringify({ 'user@example.com': { apiKey: 'cached-key', apiKeyId: 'cached-id' } }),
  )
  const keyMints = { count: 0 }
  globalThis.fetch = mockVerifyAndKeyMintCounter(keyMints)

  chmodSync(cachePath, 0o000)
  try {
    if (readableDespiteNoPermissions(cachePath)) return
    await expect(
      completeAimlapiCodeSignIn(
        'user@example.com',
        '123456',
        undefined,
        'https://api.example.test/v1',
      ),
    ).rejects.toThrow(/Could not read the local AI\/ML API sign-in key cache/)
  } finally {
    // Best-effort: the fixed code path never gets far enough to touch this
    // file, but tolerate it being gone regardless so cleanup itself is never
    // what fails the test.
    try {
      chmodSync(cachePath, 0o600)
    } catch {
      // Nothing to restore.
    }
  }

  // An unreadable cache must never be mistaken for "no cached key" — that
  // would authorize a second, orphan-risking createKey call for an account
  // that may already have one minted.
  expect(keyMints.count).toBe(0)
})

test('a malformed-JSON sign-in key cache fails closed instead of minting a fresh key', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const cachePath = join(configDirectory, 'aimlapi-signin-key.json')
  writeFileSync(cachePath, '{ this is not valid json')
  const keyMints = { count: 0 }
  globalThis.fetch = mockVerifyAndKeyMintCounter(keyMints)

  await expect(
    completeAimlapiCodeSignIn(
      'user@example.com',
      '123456',
      undefined,
      'https://api.example.test/v1',
    ),
  ).rejects.toThrow(/is not valid JSON/)

  expect(keyMints.count).toBe(0)
  expect(readFileSync(cachePath, 'utf8')).toBe('{ this is not valid json')
})

test('an array-shaped sign-in key cache fails closed instead of degrading to an empty store', async () => {
  // Valid JSON, but not an object: typeof [] === 'object' && [] !== null, so
  // this must be rejected explicitly — otherwise it silently degrades to "no
  // cached key", authorizing a second, orphan-risking createKey call.
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const cachePath = join(configDirectory, 'aimlapi-signin-key.json')
  writeFileSync(cachePath, '[1,2,3]')
  const keyMints = { count: 0 }
  globalThis.fetch = mockVerifyAndKeyMintCounter(keyMints)

  await expect(
    completeAimlapiCodeSignIn(
      'user@example.com',
      '123456',
      undefined,
      'https://api.example.test/v1',
    ),
  ).rejects.toThrow(/does not match the expected format/)

  expect(keyMints.count).toBe(0)
  expect(readFileSync(cachePath, 'utf8')).toBe('[1,2,3]')
})

test('an unreadable sign-in lease file fails closed instead of minting a fresh key', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const leasePath = join(configDirectory, 'aimlapi-signin-lease.json')
  writeFileSync(
    leasePath,
    JSON.stringify({ 'someone-else@example.com': { owner: 'peer', at: Date.now() } }),
  )
  const keyMints = { count: 0 }
  globalThis.fetch = mockVerifyAndKeyMintCounter(keyMints)

  chmodSync(leasePath, 0o000)
  try {
    if (readableDespiteNoPermissions(leasePath)) return
    await expect(
      completeAimlapiCodeSignIn(
        'user@example.com',
        '123456',
        undefined,
        'https://api.example.test/v1',
      ),
    ).rejects.toThrow(/Could not read the local AI\/ML API sign-in key-mint lease/)
  } finally {
    // Best-effort: the fixed code path never gets far enough to touch this
    // file, but tolerate it being gone regardless so cleanup itself is never
    // what fails the test.
    try {
      chmodSync(leasePath, 0o600)
    } catch {
      // Nothing to restore.
    }
  }

  // An unreadable lease file must not be mistaken for "no live lease" — a
  // competing process's still-live lease could be sitting in those
  // unreadable bytes, and minting anyway risks a second concurrent createKey.
  expect(keyMints.count).toBe(0)
})

test('a malformed-JSON sign-in lease file fails closed instead of minting a fresh key', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const leasePath = join(configDirectory, 'aimlapi-signin-lease.json')
  writeFileSync(leasePath, '{ this is not valid json')
  const keyMints = { count: 0 }
  globalThis.fetch = mockVerifyAndKeyMintCounter(keyMints)

  await expect(
    completeAimlapiCodeSignIn(
      'user@example.com',
      '123456',
      undefined,
      'https://api.example.test/v1',
    ),
  ).rejects.toThrow(/is not valid JSON/)

  expect(keyMints.count).toBe(0)
  expect(readFileSync(leasePath, 'utf8')).toBe('{ this is not valid json')
})

test('an array-shaped sign-in lease file fails closed instead of degrading to an empty store', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const leasePath = join(configDirectory, 'aimlapi-signin-lease.json')
  writeFileSync(leasePath, '[1,2,3]')
  const keyMints = { count: 0 }
  globalThis.fetch = mockVerifyAndKeyMintCounter(keyMints)

  await expect(
    completeAimlapiCodeSignIn(
      'user@example.com',
      '123456',
      undefined,
      'https://api.example.test/v1',
    ),
  ).rejects.toThrow(/does not match the expected format/)

  expect(keyMints.count).toBe(0)
  expect(readFileSync(leasePath, 'utf8')).toBe('[1,2,3]')
})

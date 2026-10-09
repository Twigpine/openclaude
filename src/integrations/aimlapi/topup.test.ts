import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  acquireAimlapiExchangeLeaseAsync,
  acquireAimlapiKeyMintLeaseAsync,
  claimAimlapiTopupState,
  clearAimlapiTopupState,
  loadAimlapiTopupState,
  recordAimlapiSettledKeyAsync,
  saveAimlapiTopupState,
  type AimlapiPersistedTopup,
} from './topupState.js'
import {
  isValidAimlapiEmail,
  isValidAimlapiSignInCode,
  parseAimlapiAmountUsd,
} from './validation.js'
import {
  pollUntilPaid,
  provisionAimlapiKey,
  runAimlapiTopup,
  setAimlapiTopupTestDoubles,
  topUpAimlapiByApiKey,
  type AimlapiTopupStatus,
} from './topup.js'
import { AimlapiClient } from './client.js'

let lastSavedProfileEnv: Record<string, unknown> | undefined
// Inject the profile writer + prompt stubs through the module's own DI seam
// rather than a process-global `mock.module` (which leaks across test files in
// this repo). The transport is stubbed per-test via `globalThis.fetch`.
setAimlapiTopupTestDoubles({
  writeProfile: options => {
    lastSavedProfileEnv = options.env as Record<string, unknown>
    return 'profile.json'
  },
  promptText: async () => '',
  promptHidden: async () => '',
})

// createSession/getSession responses are validated against the full
// PartnerCheckoutSession contract, so mocks must carry id + partnerId too.
function sessionJson(session: Record<string, unknown>): Response {
  // The current client validates the full PartnerCheckoutSession contract,
  // including the nullable-but-required fields, so carry them as null.
  return Response.json({
    id: 'sess_test',
    partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    partnerName: null,
    userId: null,
    amountUsdMinor: null,
    issuedKeyId: null,
    returnUrl: null,
    ...session,
  })
}

const originalFetch = globalThis.fetch
const originalEnv = {
  AIMLAPI_AUTH_URL: process.env.AIMLAPI_AUTH_URL,
  AIMLAPI_APP_URL: process.env.AIMLAPI_APP_URL,
  AIMLAPI_INFERENCE_URL: process.env.AIMLAPI_INFERENCE_URL,
  AIMLAPI_PAY_URL: process.env.AIMLAPI_PAY_URL,
  AIMLAPI_PARTNER_ID: process.env.AIMLAPI_PARTNER_ID,
  AIMLAPI_VERIFICATION_BASE_URL: process.env.AIMLAPI_VERIFICATION_BASE_URL,
  AIMLAPI_RETURN_URL: process.env.AIMLAPI_RETURN_URL,
  AIMLAPI_EMAIL: process.env.AIMLAPI_EMAIL,
  AIMLAPI_CODE: process.env.AIMLAPI_CODE,
}
const temporaryDirectories: string[] = []

afterAll(() => {
  setAimlapiTopupTestDoubles(undefined)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  lastSavedProfileEnv = undefined
  setClaudeConfigHomeDirForTesting(undefined)
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('parseAimlapiAmountUsd enforces checkout bounds', () => {
  expect(parseAimlapiAmountUsd(undefined)).toBe(2500)
  expect(parseAimlapiAmountUsd('20')).toBe(2000)
  expect(parseAimlapiAmountUsd('25.25')).toBe(2525)
  expect(parseAimlapiAmountUsd('10000')).toBe(1_000_000)
  expect(() => parseAimlapiAmountUsd('19.99')).toThrow('Minimum top-up is $20')
  expect(() => parseAimlapiAmountUsd('10000.01')).toThrow('Maximum top-up is $10000')
  expect(() => parseAimlapiAmountUsd('19.999')).toThrow('Pass a valid USD amount')
  expect(() => parseAimlapiAmountUsd('10000.004')).toThrow('Pass a valid USD amount')
  // Scientific notation must not slip sub-cent precision past the rounding.
  expect(() => parseAimlapiAmountUsd('20.001e0')).toThrow('Pass a valid USD amount')
  expect(() => parseAimlapiAmountUsd('2.0001e1')).toThrow('Pass a valid USD amount')
  expect(() => parseAimlapiAmountUsd('nope')).toThrow('Pass a positive number of USD')
  expect(() => parseAimlapiAmountUsd('Infinity')).toThrow('Pass a positive number of USD')
})

test('isValidAimlapiEmail rejects incomplete domains', () => {
  expect(isValidAimlapiEmail('user@example.com')).toBe(true)
  expect(isValidAimlapiEmail('user@example')).toBe(false)
  expect(isValidAimlapiEmail('user@example.c')).toBe(false)
  expect(isValidAimlapiEmail('user@.example.com')).toBe(false)
})

test('isValidAimlapiSignInCode accepts only a 6-digit numeric code', () => {
  expect(isValidAimlapiSignInCode('123456')).toBe(true)
  expect(isValidAimlapiSignInCode('  123456  ')).toBe(true)
  expect(isValidAimlapiSignInCode('')).toBe(false)
  expect(isValidAimlapiSignInCode('   ')).toBe(false)
  expect(isValidAimlapiSignInCode('abc')).toBe(false)
  expect(isValidAimlapiSignInCode('abcdef')).toBe(false)
  expect(isValidAimlapiSignInCode('12345')).toBe(false)
  expect(isValidAimlapiSignInCode('1234567')).toBe(false)
  expect(isValidAimlapiSignInCode('12345a')).toBe(false)
  expect(isValidAimlapiSignInCode('123 456')).toBe(false)
})

test('a malformed --code is rejected locally before it ever reaches verifySignInCode', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'

  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) {
      throw new Error('verifySignInCode must not be called for a malformed code')
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  for (const malformed of ['abcdef', '12345', '1234567', '12345a', '123 456']) {
    await expect(
      runAimlapiTopup({
        email: 'user@example.com',
        code: malformed,
        amountUsd: '25',
        noOpen: true,
      }),
    ).rejects.toThrow('Sign-in code must be the 6-digit code sent by email.')
  }
})

test('CLI retries reuse the persisted checkout session and payment id', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'

  let accountChecks = 0
  const payBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) {
      accountChecks += 1
      return Response.json({ action: accountChecks === 1 ? 'sign-up' : 'sign-in' })
    }
    if (url.endsWith('/passwordless')) {
      return Response.json({ token: 'account-token-one', exp: 1 })
    }
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) {
      return Response.json({ token: 'account-token-two', exp: 2 })
    }
    if (url.endsWith('/v1/keys')) {
      return Response.json({ key: 'key_test', id: 'key_id' })
    }
    if (url.endsWith('/v3/partner-checkout/sessions') && init?.method === 'POST') {
      return sessionJson({ sessionToken: 'checkout-session', status: 'pending_auth' })
    }
    if (url.endsWith('/pay')) {
      payBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      throw new Error('ambiguous payment response')
    }
    if (url.endsWith('/exchange')) {
      // The retry exchanges the paid sign-up session (the first attempt's pay
      // response was ambiguous but the session is now paid) instead of minting an
      // unrelated key.
      return Response.json({ apiKey: 'exchanged_key', apiKeyId: 'exchanged_id' })
    }
    if (url.endsWith('/v3/partner-checkout/sessions/checkout-session')) {
      return sessionJson({ sessionToken: 'checkout-session', status: 'paid' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  await expect(
    runAimlapiTopup({ email: 'user@example.com', amountUsd: '25', noOpen: true }),
  ).rejects.toThrow('ambiguous payment response')

  const saved = JSON.parse(
    readFileSync(join(configDirectory, 'aimlapi-topup.json'), 'utf8'),
  ) as { paymentSessionId: string; resumeSessionToken: string }
  expect(saved.paymentSessionId).toBeTruthy()
  expect(saved.resumeSessionToken).toBe('checkout-session')
  expect(payBodies).toHaveLength(1)
  expect(payBodies[0]?.paymentSessionId).toBe(saved.paymentSessionId)

  await runAimlapiTopup({
    email: 'user@example.com',
    code: '123456',
    amountUsd: '25',
    noOpen: true,
  })
  expect(payBodies).toHaveLength(1)
  expect(() => readFileSync(join(configDirectory, 'aimlapi-topup.json'))).toThrow()
})

test('sign-in adopts a peer-recorded key instead of minting a second one', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  const statePath = join(configDirectory, 'aimlapi-topup.json')

  let keyMints = 0
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) {
      // This process already claimed (synchronously, before the first await)
      // and its own in-memory checkoutState.apiKey is still empty. A peer
      // running the SAME intent races ahead and records its own key during
      // this await gap — matching this exact record's intent + payment id,
      // read back off disk since paymentSessionId is a fresh random UUID.
      const claimedState = JSON.parse(readFileSync(statePath, 'utf8'))
      saveAimlapiTopupState({ ...claimedState, apiKey: 'peer-key', apiKeyId: 'peer-id' })
      return Response.json({ token: 'account-token', exp: 1 })
    }
    if (url.endsWith('/v1/keys')) {
      keyMints += 1
      return Response.json({ key: 'minted-key', id: 'minted-id' })
    }
    if (url.endsWith('/v3/partner-checkout/sessions') && init?.method === 'POST') {
      return sessionJson({ sessionToken: 'checkout-session', status: 'pending_auth' })
    }
    // Fail right after the retained-key check — full payment settlement is
    // not what's under test here.
    if (url.endsWith('/pay')) throw new Error('ambiguous payment response')
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  await expect(
    runAimlapiTopup({ email: 'user@example.com', code: '123456', amountUsd: '25', noOpen: true }),
  ).rejects.toThrow('ambiguous payment response')

  // The peer's key was adopted — this process never minted its own.
  expect(keyMints).toBe(0)
  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
    apiKey: string
    apiKeyId: string
  }
  expect(saved.apiKey).toBe('peer-key')
  expect(saved.apiKeyId).toBe('peer-id')
})

test('two concurrent sign-ins for the same intent never both mint a key', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  const statePath = join(configDirectory, 'aimlapi-topup.json')

  let keyMints = 0
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) return Response.json({ token: 'account-token', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      keyMints += 1
      // Hold the POST open long enough for the concurrent run to reach its
      // own lease acquire attempt and observe this one still in flight
      // (status 'held'), instead of racing it to a second POST.
      await new Promise(resolve => setTimeout(resolve, 200))
      return Response.json({ key: `minted-key-${keyMints}`, id: `minted-id-${keyMints}` })
    }
    if (url.endsWith('/v3/partner-checkout/sessions') && init?.method === 'POST') {
      return sessionJson({ sessionToken: 'checkout-session', status: 'pending_auth' })
    }
    // Both runs fail the same way right after the key-mint step — full
    // payment settlement is not what's under test here.
    if (url.endsWith('/pay')) throw new Error('ambiguous payment response')
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const runOnce = () =>
    runAimlapiTopup({ email: 'user@example.com', code: '123456', amountUsd: '25', noOpen: true })

  const [resultA, resultB] = await Promise.allSettled([runOnce(), runOnce()])
  expect(resultA.status).toBe('rejected')
  expect(resultB.status).toBe('rejected')

  // The core guarantee: exactly one POST /v1/keys happened, not two — the
  // loser's lease-acquire attempt found the winner's lease held and adopted
  // its recorded key instead of minting (and orphaning) its own.
  expect(keyMints).toBe(1)
  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { apiKey: string }
  expect(saved.apiKey).toBe('minted-key-1')
}, 10_000)

test('an ambiguous key-mint failure holds the lease instead of releasing it for a retry to double-mint', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  const statePath = join(configDirectory, 'aimlapi-topup.json')

  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) return Response.json({ token: 'account-token', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      // The POST may have minted a key server-side before this response was
      // lost — createKey is non-idempotent and irrecoverable, so the caller
      // must not treat this as safe to blindly retry.
      throw new Error('network error: response lost')
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  await expect(
    runAimlapiTopup({ email: 'user@example.com', code: '123456', amountUsd: '25', noOpen: true }),
  ).rejects.toThrow(/network request.*failed/i)

  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
    apiKey?: string
    keyMintLeaseOwner?: string
    keyMintLeaseAt?: number
  }
  expect(saved.apiKey ?? '').toBe('')
  // The lease must still be held — releasing it here would let a retry mint
  // (and orphan) a second key while the first POST's outcome is unknown.
  expect(saved.keyMintLeaseOwner).toBeTruthy()
  expect(saved.keyMintLeaseAt).toBeGreaterThan(0)
})

test('a receipt-write failure right after a successful key mint stops the flow instead of stranding the key', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  const statePath = join(configDirectory, 'aimlapi-topup.json')

  // A file (not a directory) at the path the config dir is switched to right
  // as createKey succeeds — forces the post-mint receipt save's own
  // mkdirSync (ensureOwnerOnlyDir) to fail with ENOTDIR deterministically and
  // portably, simulating a real lock/permission/IO-class failure without
  // relying on OS-specific permission semantics (mirrors the analogous
  // post-exchange receipt-write-failure test above).
  const brokenParent = join(configDirectory, 'not-a-directory')
  writeFileSync(brokenParent, '')
  const brokenConfigDir = join(brokenParent, 'nested')

  let keyMints = 0
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) return Response.json({ token: 'account-token', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      keyMints += 1
      // The key is minted server-side — genuinely successful — but the
      // config dir is switched to a broken path right before returning, so
      // the receipt-write that follows fails deterministically.
      setClaudeConfigHomeDirForTesting(brokenConfigDir)
      return Response.json({ key: 'minted-key', id: 'minted-id' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const error = await runAimlapiTopup({
    email: 'user@example.com',
    code: '123456',
    amountUsd: '25',
    noOpen: true,
  }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toMatch(/recovery receipt could not be saved/i)
  // The issued key id is the recovery handle this error exists to surface —
  // without it, the dashboard-rotation guidance has nothing to point the
  // user at, so the message must name it, not just describe the failure.
  expect(message).toContain('minted-id')
  // Exactly one createKey call: the flow stopped instead of retrying blindly
  // within the same run.
  expect(keyMints).toBe(1)

  // Restore the good directory to inspect what was actually left behind —
  // the lease was acquired (and, on the earlier mint, the intent claimed) in
  // the ORIGINAL directory, before the switch.
  setClaudeConfigHomeDirForTesting(configDirectory)
  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as AimlapiPersistedTopup

  // Never reached the checkout/payment step: the flow stopped, rather than
  // risking a silent loss if the checkout also failed or the process exited
  // before a later save could catch it.
  expect(saved.apiKey ?? '').toBe('')
  // The lease must still be held — releasing it here would let a retry mint
  // (and orphan) a second key while this one's receipt remains unresolved.
  expect(saved.keyMintLeaseOwner).toBeTruthy()
  expect(saved.keyMintLeaseAt).toBeGreaterThan(0)

  // A retry (a fresh lease-acquire attempt for the same intent + payment id)
  // must see the lease as held, not free — proving it would neither issue a
  // second key nor silently overwrite this still-unresolved record.
  const { paymentSessionId } = saved
  const retryLease = await acquireAimlapiKeyMintLeaseAsync(
    { ...saved, paymentSessionId },
    'retry-owner',
  )
  expect(retryLease.status).toBe('held')
  if (retryLease.status === 'held') {
    expect(retryLease.owner).toBe(saved.keyMintLeaseOwner ?? '')
  }
})

test('a stale-lease takeover mints exactly once: the reclaiming run succeeds and the delayed original is rejected, not silently double-recorded', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  const statePath = join(configDirectory, 'aimlapi-topup.json')

  let keyMints = 0
  let firstMintStarted: () => void
  const firstMintStartedPromise = new Promise<void>(resolve => {
    firstMintStarted = resolve
  })
  let releaseFirstMint: () => void
  const firstMintHeld = new Promise<void>(resolve => {
    releaseFirstMint = resolve
  })
  let secondMintStarted: () => void
  const secondMintStartedPromise = new Promise<void>(resolve => {
    secondMintStarted = resolve
  })
  let releaseSecondMint: () => void
  const secondMintHeld = new Promise<void>(resolve => {
    releaseSecondMint = resolve
  })

  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) return Response.json({ token: 'account-token', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      keyMints += 1
      if (keyMints === 1) {
        // The first run's createKey response is held open (simulating a very
        // slow/suspended request) so its lease can be reclaimed while it is
        // still in flight.
        firstMintStarted()
        await firstMintHeld
        return Response.json({ key: 'first-key', id: 'first-id' })
      }
      // The second (reclaiming) run's response is ALSO held open, so its own
      // checkpoint has not landed yet when the first run's delayed result is
      // released — otherwise the first run would simply adopt the second
      // run's already-recorded key instead of exercising the rejection this
      // test is for.
      secondMintStarted()
      await secondMintHeld
      return Response.json({ key: 'second-key', id: 'second-id' })
    }
    // Neither run should reach checkout/payment in this test.
    if (url.endsWith('/v3/partner-checkout/sessions')) {
      throw new Error('checkout must not start in this test')
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const firstRun = runAimlapiTopup({
    email: 'user@example.com',
    code: '123456',
    amountUsd: '25',
    noOpen: true,
  }).catch((caught: unknown) => caught)
  await firstMintStartedPromise

  // Age the first run's lease past KEY_MINT_LEASE_STALE_MS (75s) — mirrors a
  // real client-side timeout or suspended process, not an abandoned attempt.
  const aged = JSON.parse(readFileSync(statePath, 'utf8'))
  aged.keyMintLeaseAt = Date.now() - 100_000
  writeFileSync(statePath, JSON.stringify(aged))

  // A second, independent run reclaims the now-stale lease and starts
  // minting too — this is what the reclaim mechanism exists to allow.
  const secondRun = runAimlapiTopup({
    email: 'user@example.com',
    code: '123456',
    amountUsd: '25',
    noOpen: true,
  }).catch((caught: unknown) => caught)
  await secondMintStartedPromise

  // Release the FIRST run's long-delayed response while the second run's own
  // checkpoint has NOT landed yet: no key is recorded, and the lease belongs
  // to the second run's owner — this is exactly the "ownership lost, nothing
  // to adopt" case that must be rejected rather than written.
  releaseFirstMint!()
  const firstRunResult = await firstRun
  expect(firstRunResult).toBeInstanceOf(Error)
  expect((firstRunResult as Error).message).toMatch(/recovery receipt could not be saved/i)
  expect((firstRunResult as Error).message).toContain('first-id')

  // The rejection must not have touched the still-in-flight second run's
  // lease or recorded the first run's key.
  const midState = JSON.parse(readFileSync(statePath, 'utf8')) as AimlapiPersistedTopup
  expect(midState.apiKey ?? '').toBe('')
  expect(midState.keyMintLeaseOwner).toBeTruthy()

  // Now let the second run's response land — it still owns the lease, so its
  // key is recorded normally and the checkout recovers cleanly.
  releaseSecondMint!()
  const secondRunResult = await secondRun
  expect((secondRunResult as Error)?.message).toContain('checkout must not start')

  // Exactly two createKey calls total — never a third from any retry the
  // first run's rejection might have triggered.
  expect(keyMints).toBe(2)

  // The second run's key is the one durably recorded — the first run's own
  // (equally real, equally minted) key was correctly rejected rather than
  // silently overwriting or being overwritten by it.
  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as AimlapiPersistedTopup
  expect(saved.apiKey).toBe('second-key')
  expect(saved.apiKeyId).toBe('second-id')
  expect(saved.keyMintLeaseOwner).toBeUndefined()
}, 10_000)

test('a 2xx createKey response with an unusable body holds the checkout key-mint lease too', async () => {
  // POST /v1/keys is non-idempotent: a 2xx status means the server received
  // and likely committed the request, even when the body that would have
  // confirmed it is unusable. Each of these must be held ambiguous, not
  // treated as proof nothing was created — mirrors the sign-in mint path's
  // equivalent test in onboarding.test.ts.
  const malformedResponses: Record<string, () => Response> = {
    empty: () => new Response('', { status: 200 }),
    'non-json': () => new Response('not json', { status: 200 }),
    oversized: () => new Response('x'.repeat((1 << 20) + 1), { status: 200 }),
    'missing-id': () => new Response(JSON.stringify({ key: 'k_test' }), { status: 200 }),
    'missing-key': () => new Response(JSON.stringify({ id: 'id_test' }), { status: 200 }),
  }

  for (const [label, makeResponse] of Object.entries(malformedResponses)) {
    const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
    temporaryDirectories.push(configDirectory)
    setClaudeConfigHomeDirForTesting(configDirectory)
    process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
    process.env.AIMLAPI_APP_URL = 'https://app.example.test'
    process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
    const statePath = join(configDirectory, 'aimlapi-topup.json')

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
      if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
      if (url.endsWith('/code/verify')) return Response.json({ token: 'account-token', exp: 1 })
      if (url.endsWith('/v1/keys')) return makeResponse()
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch

    await expect(
      runAimlapiTopup({ email: 'user@example.com', code: '123456', amountUsd: '25', noOpen: true }),
    ).rejects.toThrow()

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      apiKey?: string
      keyMintLeaseOwner?: string
      keyMintLeaseAt?: number
    }
    expect(saved.apiKey ?? '', `no key recorded after a ${label} 2xx response`).toBe('')
    expect(saved.keyMintLeaseOwner, `lease held after a ${label} 2xx response`).toBeTruthy()
    expect(saved.keyMintLeaseAt).toBeGreaterThan(0)
  }
})

test('a competing claim cannot orphan a key mint already in flight for a different intent', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  const statePath = join(configDirectory, 'aimlapi-topup.json')

  let releaseKeyMintPost: (() => void) | undefined
  const keyMintPostHeld = new Promise<void>(resolve => {
    releaseKeyMintPost = resolve
  })
  let signalKeyMintReached: (() => void) | undefined
  const keyMintReached = new Promise<void>(resolve => {
    signalKeyMintReached = resolve
  })

  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) return Response.json({ token: 'account-token', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      // Hold the non-idempotent POST open — the record has already been
      // claimed and its key-mint lease acquired at this point, but no
      // resumeSessionToken/settled/apiKey exists yet, so it still "looks"
      // blank to a naive in-progress check.
      signalKeyMintReached?.()
      await keyMintPostHeld
      return Response.json({ key: 'minted-key', id: 'minted-id' })
    }
    if (url.endsWith('/v3/partner-checkout/sessions') && init?.method === 'POST') {
      return sessionJson({ sessionToken: 'checkout-session', status: 'pending_auth' })
    }
    // Fail right after the retained-key check — full payment settlement is
    // not what's under test here.
    if (url.endsWith('/pay')) throw new Error('ambiguous payment response')
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const run = runAimlapiTopup({
    email: 'user@example.com',
    code: '123456',
    amountUsd: '25',
    noOpen: true,
  })

  // The run has claimed the receipt and acquired the key-mint lease by the
  // time the held-open POST is reached — deterministic, unlike a fixed sleep
  // that could be missed on a loaded CI runner.
  await keyMintReached
  const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { amountUsdMinor: number }
  expect(persisted.amountUsdMinor).toBe(2500)

  // A different amount is a different intent/payment id. The record still
  // has no resumeSessionToken/settled/apiKey, but its key-mint lease is live
  // — replacing it here would let the in-flight mint's eventual CAS save
  // find no matching record, orphaning the credential it is about to mint.
  expect(() =>
    claimAimlapiTopupState({
      email: 'user@example.com',
      amountUsdMinor: 5000,
      autoTopUp: false,
      partnerId: 'part_test',
      partnerName: 'Twigpine',
      appBaseUrl: 'https://app.example.test',
      inferenceBaseUrl: 'https://api.example.test/v1',
      payBaseUrl: 'https://pay.example.test',
      verificationBaseUrl: 'https://front.example.test',
    }),
  ).toThrow(/minting or exchanging/i)

  releaseKeyMintPost?.()
  await expect(run).rejects.toThrow('ambiguous payment response')

  // The original (never-replaced) record recovered the minted key.
  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
    apiKey?: string
    amountUsdMinor: number
  }
  expect(saved.apiKey).toBe('minted-key')
  expect(saved.amountUsdMinor).toBe(2500)
}, 10_000)

test('a successful exchange persists the settled receipt before returning it', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-exch-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'

  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    partnerName: 'OpenClaude',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.aimlapi.com/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  }
  const claimed = claimAimlapiTopupState(intent)
  saveAimlapiTopupState({
    ...intent,
    paymentSessionId: claimed.paymentSessionId,
    resumeSessionToken: 'paid-session',
  })

  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v3/partner-checkout/sessions/paid-session')) {
      return sessionJson({ sessionToken: 'paid-session', status: 'paid' })
    }
    if (url.endsWith('/exchange')) {
      return Response.json({ apiKey: 'exchanged_key', apiKeyId: 'exchanged_id' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const provisioned = await provisionAimlapiKey({
    sessionToken: 'account-session',
    resumeSessionToken: 'paid-session',
    paymentSessionId: claimed.paymentSessionId,
    exchange: true,
    intent,
    amountUsd: '25',
    model: 'gpt-4o',
    noOpen: true,
  })
  expect(provisioned.apiKey).toBe('exchanged_key')

  // The one-shot /exchange is non-idempotent, so exchangeKeyWithLease records the
  // settled receipt under the CAS BEFORE returning: an interruption before the
  // caller's own profile/receipt write still recovers the paid key rather than
  // re-running (and being rejected by) the spent exchange.
  const saved = loadAimlapiTopupState(intent)
  expect(saved?.settled).toBe(true)
  expect(saved?.apiKey).toBe('exchanged_key')
  expect(saved?.apiKeyId).toBe('exchanged_id')
})

test('provisionAimlapiKey itself fails when the post-exchange settled-receipt commit fails — not just its caller', async () => {
  // Isolates exchangeKeyWithLease's OWN checkpoint from the CLI's separate,
  // already-fatal outer save (runAimlapiTopup's saveAimlapiTopupState call,
  // which would also fail against the same broken directory and could mask
  // a regression here): provisionAimlapiKey has no outer save of its own, so
  // if IT throws, the failure can only have come from
  // recordAimlapiSettledKeyAsync being treated as a required commit.
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-exch-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'

  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    partnerName: 'OpenClaude',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.aimlapi.com/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  }
  const claimed = claimAimlapiTopupState(intent)
  saveAimlapiTopupState({
    ...intent,
    paymentSessionId: claimed.paymentSessionId,
    resumeSessionToken: 'paid-session',
  })

  // A file (not a directory) at the path the config dir is switched to right
  // as the exchange settles — forces the checkpoint's own mkdirSync
  // (ensureOwnerOnlyDir) to fail with ENOTDIR deterministically and
  // portably, without relying on OS-specific permission semantics.
  const brokenParent = join(configDirectory, 'not-a-directory')
  writeFileSync(brokenParent, '')
  const brokenConfigDir = join(brokenParent, 'nested')

  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v3/partner-checkout/sessions/paid-session')) {
      return sessionJson({ sessionToken: 'paid-session', status: 'paid' })
    }
    if (url.endsWith('/exchange')) {
      setClaudeConfigHomeDirForTesting(brokenConfigDir)
      return Response.json({ apiKey: 'exchanged_key', apiKeyId: 'exchanged_id' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const error = await provisionAimlapiKey({
    sessionToken: 'account-session',
    resumeSessionToken: 'paid-session',
    paymentSessionId: claimed.paymentSessionId,
    exchange: true,
    intent,
    amountUsd: '25',
    model: 'gpt-4o',
    noOpen: true,
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toMatch(/recovery receipt could not be saved/i)
  expect(message).toContain('exchanged_id')

  // Restore the good directory: the exchange lease was acquired there before
  // the switch, and the write that would have cleared it never landed — it
  // must still be held, blocking a retry from sending a second /exchange for
  // this already-spent, one-shot session while the key remains unrecorded.
  setClaudeConfigHomeDirForTesting(configDirectory)
  const saved = loadAimlapiTopupState(intent)
  expect(saved?.settled ?? false).toBe(false)
  expect(saved?.apiKey ?? '').toBe('')
  const retryLease = await acquireAimlapiExchangeLeaseAsync(
    { ...intent, paymentSessionId: claimed.paymentSessionId },
    'retry-owner',
  )
  expect(retryLease.status).toBe('held')
})

test('provisionAimlapiKey fails when the settled-receipt commit is a no-op, not just when it throws', async () => {
  // recordAimlapiSettledKeyAsync returns false (rather than throwing) when the
  // checkout record was cleared/reset out from under its CAS between the
  // /exchange succeeding and this call landing — e.g. a concurrent `topup reset`.
  // That's just as unrecoverable as an I/O failure: this call is still the only
  // place the exchanged key was ever recorded, so it must fail the same way.
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-exch-noop-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'

  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    partnerName: 'OpenClaude',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.aimlapi.com/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  }
  const claimed = claimAimlapiTopupState(intent)
  const expected = { ...intent, paymentSessionId: claimed.paymentSessionId }
  saveAimlapiTopupState({
    ...intent,
    paymentSessionId: claimed.paymentSessionId,
    resumeSessionToken: 'paid-session',
  })

  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v3/partner-checkout/sessions/paid-session')) {
      return sessionJson({ sessionToken: 'paid-session', status: 'paid' })
    }
    if (url.endsWith('/exchange')) {
      // Simulate a concurrent reset landing between the /exchange response and
      // the checkpoint's own read of the record: matchingStateOrNull(expected)
      // will find nothing, and the old code silently returned instead of
      // signaling anything went wrong.
      clearAimlapiTopupState(expected)
      return Response.json({ apiKey: 'exchanged_key', apiKeyId: 'exchanged_id' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const error = await provisionAimlapiKey({
    sessionToken: 'account-session',
    resumeSessionToken: 'paid-session',
    paymentSessionId: claimed.paymentSessionId,
    exchange: true,
    intent,
    amountUsd: '25',
    model: 'gpt-4o',
    noOpen: true,
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toMatch(/recovery receipt could not be saved/i)
  expect(message).toContain('exchanged_id')
})

test('a receipt-write failure right after a successful exchange stops the flow instead of stranding the key', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'

  // A file (not a directory) at the path the config dir is switched to right
  // as the exchange settles — forces the post-exchange receipt save's own
  // mkdirSync (ensureOwnerOnlyDir) to fail with ENOTDIR deterministically and
  // portably, simulating a real lock/permission/IO-class failure without
  // relying on OS-specific permission semantics.
  const brokenParent = join(configDirectory, 'not-a-directory')
  writeFileSync(brokenParent, '')
  const brokenConfigDir = join(brokenParent, 'nested')

  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-up' })
    if (url.endsWith('/passwordless')) return Response.json({ token: 'account-token', exp: 1 })
    if (url.endsWith('/v3/partner-checkout/sessions') && init?.method === 'POST') {
      return sessionJson({ sessionToken: 'checkout-session', status: 'pending_auth' })
    }
    if (url.endsWith('/pay')) {
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test/pay' },
        partnerCheckout: {
          id: 'sess_test',
          partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
          partnerName: null,
          userId: null,
          amountUsdMinor: null,
          issuedKeyId: null,
          returnUrl: null,
          sessionToken: 'checkout-session',
          status: 'pending_payment',
        },
      })
    }
    if (url.endsWith('/v3/partner-checkout/sessions/checkout-session')) {
      return sessionJson({ sessionToken: 'checkout-session', status: 'paid' })
    }
    if (url.endsWith('/exchange')) {
      // The exchange itself succeeds — the key is minted server-side — but the
      // config dir is switched to a broken path right before returning, so
      // the receipt-write that follows fails deterministically.
      setClaudeConfigHomeDirForTesting(brokenConfigDir)
      return Response.json({ apiKey: 'exchanged-key', apiKeyId: 'exchanged-id' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const error = await runAimlapiTopup({
    email: 'user@example.com',
    amountUsd: '25',
    noOpen: true,
  }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toMatch(/recovery receipt could not be saved/i)
  // The issued key id is the recovery handle this error exists to surface —
  // without it, the dashboard-rotation guidance has nothing to point the user
  // at, so the message must name it, not just describe the failure generically.
  expect(message).toContain('exchanged-id')

  // Never reached the profile write: the flow stopped, rather than risking a
  // silent loss if that write had also failed or the process had exited
  // right after.
  expect(lastSavedProfileEnv).toBeUndefined()

  // The exchange lease was acquired in the ORIGINAL (good) directory before
  // the switch, and the write that would have cleared it never landed — it
  // must still be held, blocking a retry from sending a second /exchange for
  // this already-spent, one-shot session while the key remains unrecorded.
  setClaudeConfigHomeDirForTesting(configDirectory)
  const statePath = join(configDirectory, 'aimlapi-topup.json')
  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as AimlapiPersistedTopup
  expect(saved.settled ?? false).toBe(false)
  expect(saved.apiKey ?? '').toBe('')
  expect(saved.exchangeLeaseOwner).toBeTruthy()
  expect(saved.exchangeLeaseAt).toBeGreaterThan(0)
  const retryLease = await acquireAimlapiExchangeLeaseAsync(
    { ...saved, paymentSessionId: saved.paymentSessionId },
    'retry-owner',
  )
  expect(retryLease.status).toBe('held')
})

test('a sibling that cleared the checkout aborts instead of paying twice', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'

  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method} ${url}`)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-up' })
    if (url.endsWith('/passwordless')) return Response.json({ token: 'session', exp: 1 })
    if (url.endsWith('/v3/partner-checkout/sessions') && init?.method === 'POST') {
      // Simulate a concurrent sibling that finished and cleared this exact
      // top-up between our claim and our session-election write.
      rmSync(join(configDirectory, 'aimlapi-topup.json'), { force: true })
      return sessionJson({ sessionToken: 'checkout-session', status: 'pending_auth' })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  await expect(
    runAimlapiTopup({ email: 'new@example.com', amountUsd: '25', noOpen: true }),
  ).rejects.toThrow(/already completed or cancelled/i)
  // The election aborts before any /pay call — no second charge is opened.
  expect(calls.some(call => call.endsWith('/pay'))).toBe(false)
})

test('CLI retains an already-exchanged checkout and blocks identical retries', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  const persisted = claimAimlapiTopupState({
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    partnerName: 'Twigpine',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.aimlapi.com/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://aimlapi.com/app',
  })
  saveAimlapiTopupState({
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    partnerName: 'Twigpine',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.aimlapi.com/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://aimlapi.com/app',
    paymentSessionId: persisted.paymentSessionId,
    resumeSessionToken: 'exchanged-session',
  })

  let sessionReads = 0
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) {
      return Response.json({ token: 'account-token', exp: 1 })
    }
    if (url.endsWith('/v1/keys')) {
      return Response.json({ key: 'key_test', id: 'created-key' })
    }
    if (url.endsWith('/sessions/exchanged-session')) {
      sessionReads += 1
      return sessionJson({
        sessionToken: 'exchanged-session',
        status: 'exchanged',
        issuedKeyId: 'issued-key-id',
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  const retry = (): Promise<void> =>
    runAimlapiTopup({
      email: 'user@example.com',
      code: '123456',
      amountUsd: '25',
      noOpen: true,
    })

  await expect(retry()).rejects.toThrow('issued key issued-key-id')
  await expect(retry()).rejects.toThrow('issued key issued-key-id')
  expect(sessionReads).toBe(2)
  expect(
    JSON.parse(readFileSync(join(configDirectory, 'aimlapi-topup.json'), 'utf8')),
  ).toMatchObject({
    paymentSessionId: persisted.paymentSessionId,
    resumeSessionToken: 'exchanged-session',
  })
})

test('a failed payment retains the issued key for the next run', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  // Keep the canonical inference URL so the guided-provisioning gate allows the
  // run; the flow uses the app/auth/pay hosts for its requests.

  let keyMints = 0
  let sessionStatus = 'expired'
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    if (url.endsWith('/sign-in/code')) return new Response(null, { status: 204 })
    if (url.endsWith('/code/verify')) return Response.json({ token: 'account-token', exp: 1 })
    if (url.endsWith('/v1/keys')) {
      keyMints += 1
      return Response.json({ key: 'key_test', id: 'key_id' })
    }
    if (url.endsWith('/v3/partner-checkout/sessions') && init?.method === 'POST') {
      return sessionJson({ sessionToken: 'checkout-session', status: 'pending_auth' })
    }
    if (url.endsWith('/pay')) {
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test/pay' },
        partnerCheckout: { id: 'sess_test', partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ', partnerName: null, userId: null, amountUsdMinor: null, issuedKeyId: null, returnUrl: null, sessionToken: 'checkout-session', status: 'pending_payment' },
      })
    }
    if (url.endsWith('/v3/partner-checkout/sessions/checkout-session')) {
      return sessionJson({ sessionToken: 'checkout-session', status: sessionStatus })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  // First run: the payment expires. The issued key must survive the terminal reset.
  await expect(
    runAimlapiTopup({ email: 'user@example.com', code: '123456', amountUsd: '25', noOpen: true }),
  ).rejects.toThrow('Payment expired')

  const afterFailure = JSON.parse(
    readFileSync(join(configDirectory, 'aimlapi-topup.json'), 'utf8'),
  ) as { apiKey?: string; resumeSessionToken: string }
  expect(afterFailure.apiKey).toBe('key_test')
  expect(afterFailure.resumeSessionToken).toBe('')
  expect(keyMints).toBe(1)

  // Second run: the payment clears and the retained key is reused (not re-minted).
  sessionStatus = 'paid'
  await runAimlapiTopup({
    email: 'user@example.com',
    code: '123456',
    amountUsd: '25',
    noOpen: true,
  })
  expect(keyMints).toBe(1)
  expect(() => readFileSync(join(configDirectory, 'aimlapi-topup.json'))).toThrow()
})

test('the CLI refuses guided top-up on a non-canonical inference endpoint', async () => {
  process.env.AIMLAPI_INFERENCE_URL = 'https://proxy.example.test/v1'
  let fetched = false
  globalThis.fetch = mock(async () => {
    fetched = true
    return Response.json({})
  }) as unknown as typeof fetch

  await expect(
    runAimlapiTopup({ email: 'user@example.com', amountUsd: '25', noOpen: true }),
  ).rejects.toThrow('production endpoint')
  // Rejected before any account lookup or key mint.
  expect(fetched).toBe(false)
})

test('a settled interrupted run resumes the profile write without re-provisioning', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    partnerName: 'Twigpine',
    appBaseUrl: 'https://app.aimlapi.com',
    inferenceBaseUrl: 'https://api.aimlapi.com/v1',
    payBaseUrl: 'https://pay.aimlapi.com',
    verificationBaseUrl: 'https://aimlapi.com/app',
  }
  const claimed = claimAimlapiTopupState(intent)
  saveAimlapiTopupState({
    ...intent,
    paymentSessionId: claimed.paymentSessionId,
    resumeSessionToken: 'checkout-session',
    apiKey: 'exchanged-key',
    apiKeyId: 'exchanged-id',
    // Original run provisioned a non-default model.
    model: 'anthropic/claude-opus-4-8',
    settled: true,
  })

  let fetched = false
  globalThis.fetch = mock(async () => {
    fetched = true
    return Response.json({})
  }) as unknown as typeof fetch

  // Retry without --model: the default would be gpt-4o, but the settled receipt
  // must win.
  await runAimlapiTopup({ email: 'user@example.com', amountUsd: '25', noOpen: true })

  // The retained settled key finished the write — no account check/provisioning,
  // the persisted model is preserved, and the checkout state is cleared.
  expect(fetched).toBe(false)
  expect(lastSavedProfileEnv?.OPENAI_API_KEY).toBe('exchanged-key')
  expect(lastSavedProfileEnv?.OPENAI_MODEL).toBe('anthropic/claude-opus-4-8')
  expect(() => readFileSync(join(configDirectory, 'aimlapi-topup.json'))).toThrow()
})

test('topUpAimlapiByApiKey funds the key account without exchange', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method} ${url}`)
    if (url.endsWith('/v3/partner-checkout/sessions')) {
      return sessionJson({ sessionToken: 'session', status: 'pending_auth' })
    }
    if (url.endsWith('/v2/billing/topup')) {
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test' },
        partnerCheckout: { id: 'sess_test', partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ', partnerName: null, userId: null, amountUsdMinor: null, issuedKeyId: null, returnUrl: null, sessionToken: 'session', status: 'pending_payment' },
      })
    }
    if (url.endsWith('/v3/partner-checkout/sessions/session')) {
      return sessionJson({ sessionToken: 'session', status: 'paid' })
    }
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch

  const sessions: string[] = []
  const result = await topUpAimlapiByApiKey({
    apiKey: 'key_test',
    paymentSessionId: 'payment-id',
    amountUsd: '25',
    noOpen: true,
    onSession: session => {
      sessions.push(session)
    },
  })

  expect(result.apiKey).toBe('key_test')
  expect(sessions).toEqual(['session'])
  expect(calls).toEqual([
    'POST https://app.example.test/v3/partner-checkout/sessions',
    'POST https://api.example.test/v2/billing/topup',
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
  ])
  expect(calls.some(call => call.endsWith('/exchange'))).toBe(false)
})

test('topUpAimlapiByApiKey resumes a paid session without charging again', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`)
    return sessionJson({ sessionToken: 'session', status: 'paid' })
  }) as unknown as typeof fetch

  await topUpAimlapiByApiKey({
    apiKey: 'key_test',
    paymentSessionId: 'payment-id',
    resumeSessionToken: 'session',
    amountUsd: '25',
    noOpen: true,
  })

  expect(calls).toEqual([
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
  ])
})

test('a pending resumed session re-issues the idempotent checkout to recover the URL', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const topupBodies: Array<Record<string, unknown>> = []
  let reads = 0
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v2/billing/topup')) {
      topupBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test/pay' },
        partnerCheckout: {
          id: 'sess_test',
          partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
          partnerName: null,
          userId: null,
          amountUsdMinor: null,
          issuedKeyId: null,
          returnUrl: null,
          sessionToken: 'session',
          status: 'pending_payment',
        },
      })
    }
    reads += 1
    return sessionJson({
      sessionToken: 'session',
      status: reads === 1 ? 'pending_payment' : 'paid',
    })
  }) as unknown as typeof fetch

  const statuses: AimlapiTopupStatus[] = []
  await topUpAimlapiByApiKey({
    apiKey: 'key_test',
    paymentSessionId: 'payment-id',
    resumeSessionToken: 'session',
    amountUsd: '25',
    noOpen: true,
    onStatus: status => {
      statuses.push(status)
    },
  })

  // A pending_payment resume re-issues the idempotent top-up (SAME paymentSessionId
  // — no double charge) to recover the lost checkout URL, then polls to paid.
  expect(topupBodies).toHaveLength(1)
  expect(topupBodies[0]?.paymentSessionId).toBe('payment-id')
  expect(statuses).toContain('opening-checkout')
})

test('a resumed by-key session still exchanging settles before success', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const calls: string[] = []
  let reads = 0
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`)
    reads += 1
    return sessionJson({
      sessionToken: 'session',
      status: reads === 1 ? 'exchanging' : 'exchanged',
    })
  }) as unknown as typeof fetch

  const result = await topUpAimlapiByApiKey({
    apiKey: 'key_test',
    paymentSessionId: 'payment-id',
    resumeSessionToken: 'session',
    amountUsd: '25',
    noOpen: true,
  })

  expect(result.apiKey).toBe('key_test')
  // The first GET resolves the resumed session (exchanging); the settle poll
  // then waits for it to reach exchanged instead of reporting success early.
  expect(calls).toEqual([
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
  ])
})

test('a resumed sign-in top-up settles before returning the existing key', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  const calls: string[] = []
  let reads = 0
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`)
    reads += 1
    return sessionJson({
      sessionToken: 'session',
      status: reads === 1 ? 'exchanging' : 'exchanged',
    })
  }) as unknown as typeof fetch

  const result = await provisionAimlapiKey({
    exchange: false,
    existingApiKey: 'existing_key',
    existingApiKeyId: 'existing_id',
    sessionToken: 'session',
    resumeSessionToken: 'session',
    paymentSessionId: 'payment-id',
    amountUsd: '25',
    noOpen: true,
  })

  expect(result.apiKey).toBe('existing_key')
  // The account (non-exchange) resume path mirrors the by-key flow: the first GET
  // resolves the resumed session (exchanging); the settle poll then waits for it
  // to reach a terminal state instead of reporting the balance credited early.
  expect(calls).toEqual([
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
  ])
})

test('an invalid amount is rejected before any key is minted', async () => {
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'sign-in' })
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  await expect(
    runAimlapiTopup({
      email: 'user@example.com',
      code: '123456',
      amountUsd: '5',
      noOpen: true,
    }),
  ).rejects.toThrow('Minimum top-up is $20')
  expect(calls.some(call => call.endsWith('/v1/keys'))).toBe(false)
  expect(calls.some(call => call.endsWith('/sign-in/code'))).toBe(false)
})

test('an unsupported account action is rejected without provisioning', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_AUTH_URL = 'https://auth.example.test'
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/v1/auth/account')) return Response.json({ action: 'reset' })
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  // The client validates the account action at the boundary and fails closed on
  // an unknown one, so the flow never reaches its own unsupported-action guard.
  await expect(
    runAimlapiTopup({ email: 'user@example.com', amountUsd: '25', noOpen: true }),
  ).rejects.toThrow(/invalid account response/i)
  expect(calls.some(call => call.endsWith('/passwordless'))).toBe(false)
  expect(calls.some(call => call.endsWith('/v1/keys'))).toBe(false)
})

test('provisionAimlapiKey does not repeat an already completed exchange', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`)
    return sessionJson({
      sessionToken: 'session',
      status: 'exchanged',
      issuedKeyId: 'key_recoverable',
    })
  }) as unknown as typeof fetch
  const sessions: string[] = []

  await expect(
    provisionAimlapiKey({
      sessionToken: 'account-session',
      resumeSessionToken: 'session',
      paymentSessionId: 'payment-id',
      exchange: true,
      amountUsd: '25',
      noOpen: true,
      onSession: session => {
      sessions.push(session)
    },
    }),
  ).rejects.toThrow('issued key key_recoverable')

  expect(calls).toEqual([
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
  ])
  expect(sessions).toEqual([])
})

test('an in-progress exchange is observed without issuing a second exchange', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  const calls: string[] = []
  let reads = 0
  const sessions: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`)
    reads += 1
    return sessionJson({
      sessionToken: 'session',
      status: reads === 1 ? 'exchanging' : 'exchanged',
    })
  }) as unknown as typeof fetch

  // `sessionToken` (the passwordless-auth bearer) is deliberately different from
  // `resumeSessionToken` (the checkout token) so a poll that mixed them up would
  // request the wrong resource and be caught below.
  await expect(
    provisionAimlapiKey({
      sessionToken: 'account-session',
      resumeSessionToken: 'session',
      paymentSessionId: 'payment-id',
      exchange: true,
      amountUsd: '25',
      noOpen: true,
      onSession: session => {
      sessions.push(session)
    },
    }),
  ).rejects.toThrow('Session was already exchanged')
  // The resolve read and the settle-poll read must both target the checkout
  // token's session resource, never the auth bearer.
  expect(calls).toEqual([
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
    'GET https://app.example.test/v3/partner-checkout/sessions/session',
  ])
  expect(sessions).toEqual(['session'])
})

test('a peer settling mid-wait is resumed from instead of hard-failing the exchange', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'

  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_test',
    partnerName: 'Twigpine',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.example.test/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  }
  const claimed = claimAimlapiTopupState(intent)
  const expected = { ...intent, paymentSessionId: claimed.paymentSessionId }

  let reads = 0
  globalThis.fetch = mock(async () => {
    reads += 1
    if (reads === 1) {
      // resolveTopupSession's resume read: still exchanging → wait-exchange.
      return sessionJson({ sessionToken: 'session', status: 'exchanging' })
    }
    // pollUntilExchangeSettled's read: by the time this lands, a PEER process
    // has already finished /exchange and recorded the settled key — simulated
    // here as a side effect of the same request racing that write.
    await recordAimlapiSettledKeyAsync(expected, {
      apiKey: 'peer-exchanged-key',
      apiKeyId: 'peer-exchanged-id',
    })
    return sessionJson({ sessionToken: 'session', status: 'exchanged' })
  }) as unknown as typeof fetch

  const result = await provisionAimlapiKey({
    sessionToken: 'account-session',
    resumeSessionToken: 'session',
    paymentSessionId: claimed.paymentSessionId,
    exchange: true,
    intent,
    amountUsd: '25',
    noOpen: true,
  })

  // Resumed from the peer's settled receipt instead of throwing "Session was
  // already exchanged".
  expect(result.apiKey).toBe('peer-exchanged-key')
  expect(result.apiKeyId).toBe('peer-exchanged-id')
})

test('a lease reclaimed mid-wait stops the poll instead of racing the peer to /exchange', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'

  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_test',
    partnerName: 'Twigpine',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.example.test/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  }
  const claimed = claimAimlapiTopupState(intent)
  const statePath = join(configDirectory, 'aimlapi-topup.json')

  let reads = 0
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    reads += 1
    if (reads === 1) {
      // resolveTopupSession's resume read: still exchanging → wait-exchange.
      // This process now acquires the exchange lease.
      return sessionJson({ sessionToken: 'session', status: 'exchanging' })
    }
    if (reads === 2) {
      // The poll's first read: still exchanging, so it loops again. A PEER
      // reclaims the lease right here, between this read and the poll's next
      // refresh — simulated by overwriting the owner directly on disk.
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      state.exchangeLeaseOwner = 'peer-owner'
      state.exchangeLeaseAt = Date.now()
      writeFileSync(statePath, JSON.stringify(state))
      return sessionJson({ sessionToken: 'session', status: 'exchanging' })
    }
    // The peer hasn't finished yet (no settled receipt), so the recovery
    // recheck in exchangeKeyWithLease's catch also finds nothing to resume
    // from. A THIRD read (or a call to POST /exchange) means the lease loss
    // went undetected and this process raced the peer to the one-shot POST.
    throw new Error(`Unexpected further request: ${init?.method ?? 'GET'} (read ${reads})`)
  }) as unknown as typeof fetch

  await expect(
    provisionAimlapiKey({
      sessionToken: 'account-session',
      resumeSessionToken: 'session',
      paymentSessionId: claimed.paymentSessionId,
      exchange: true,
      intent,
      amountUsd: '25',
      noOpen: true,
    }),
  ).rejects.toThrow(/reclaimed by another process/i)
  expect(reads).toBe(2)
}, 10_000)

test('an ambiguous exchange failure that actually committed surfaces alreadyExchangedError instead of a generic retry', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'

  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_test',
    partnerName: 'Twigpine',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.example.test/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  }
  const claimed = claimAimlapiTopupState(intent)

  let reads = 0
  let exchangePosts = 0
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/exchange') && init?.method === 'POST') {
      exchangePosts += 1
      // The POST commits server-side but its response is lost — the caller
      // only ever sees a plain network failure, with no key in hand.
      throw new Error('network error: response lost')
    }
    reads += 1
    if (reads === 1) {
      // resolveTopupSession's resume read: already paid → exchange directly.
      return sessionJson({ sessionToken: 'session', status: 'paid' })
    }
    // The catch's recovery recheck (after the POST above throws) finds the
    // session now exchanged — proof the lost response's POST actually
    // committed.
    return sessionJson({
      sessionToken: 'session',
      status: 'exchanged',
      issuedKeyId: 'key_lost',
    })
  }) as unknown as typeof fetch

  await expect(
    provisionAimlapiKey({
      sessionToken: 'account-session',
      resumeSessionToken: 'session',
      paymentSessionId: claimed.paymentSessionId,
      exchange: true,
      intent,
      amountUsd: '25',
      noOpen: true,
    }),
  ).rejects.toThrow(/already exchanged for issued key key_lost/i)
  // /exchange is non-idempotent: the recovery path must recognize the lost
  // response instead of retrying the POST itself.
  expect(exchangePosts).toBe(1)
})

test('a caller-aborted exchange POST holds the lease instead of releasing it for a retry to double-exchange', async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), 'openclaude-aimlapi-cli-'))
  temporaryDirectories.push(configDirectory)
  setClaudeConfigHomeDirForTesting(configDirectory)
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  const statePath = join(configDirectory, 'aimlapi-topup.json')

  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_test',
    partnerName: 'Twigpine',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.example.test/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  }
  const claimed = claimAimlapiTopupState(intent)
  const controller = new AbortController()

  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/exchange') && init?.method === 'POST') {
      // The caller cancels while the POST is in flight — cancelling
      // client-side does not stop the server from completing it, so this is
      // just as ambiguous as a lost response.
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    return sessionJson({ sessionToken: 'session', status: 'paid' })
  }) as unknown as typeof fetch

  await expect(
    provisionAimlapiKey({
      sessionToken: 'account-session',
      resumeSessionToken: 'session',
      paymentSessionId: claimed.paymentSessionId,
      exchange: true,
      intent,
      amountUsd: '25',
      noOpen: true,
      signal: controller.signal,
    }),
  ).rejects.toThrow(/aborted/i)

  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
    apiKey?: string
    exchangeLeaseOwner?: string
    exchangeLeaseAt?: number
  }
  expect(saved.apiKey ?? '').toBe('')
  // The lease must still be held — releasing it here would let a retry
  // exchange (and strand) the same one-shot session a second time.
  expect(saved.exchangeLeaseOwner).toBeTruthy()
  expect(saved.exchangeLeaseAt).toBeGreaterThan(0)
})

test('email-session checkout carries the stable payment id', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_PAY_URL = 'https://pay.example.test'
  let payBody: Record<string, unknown> | undefined
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v3/partner-checkout/sessions')) {
      return sessionJson({ sessionToken: 'session', status: 'pending_auth' })
    }
    if (url.endsWith('/pay')) {
      payBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test/pay' },
        partnerCheckout: { id: 'sess_test', partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ', partnerName: null, userId: null, amountUsdMinor: null, issuedKeyId: null, returnUrl: null, sessionToken: 'session', status: 'pending_payment' },
      })
    }
    return sessionJson({ sessionToken: 'session', status: 'paid' })
  }) as unknown as typeof fetch

  await provisionAimlapiKey({
    sessionToken: 'account-session',
    paymentSessionId: 'stable-payment-id',
    exchange: false,
    existingApiKey: 'key_test',
    amountUsd: '25',
    noOpen: true,
  })

  expect(payBody?.paymentSessionId).toBe('stable-payment-id')
})

test('checkout URL must be an absolute credential-free HTTPS URL', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v3/partner-checkout/sessions')) {
      return sessionJson({ sessionToken: 'session', status: 'pending_auth' })
    }
    return Response.json({
      checkout: { providerSessionId: 'provider', payUrl: 'https://user:pass@checkout.test/pay' },
      partnerCheckout: { id: 'sess_test', partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ', partnerName: null, userId: null, amountUsdMinor: null, issuedKeyId: null, returnUrl: null, sessionToken: 'session', status: 'pending_payment' },
    })
  }) as unknown as typeof fetch

  await expect(
    topUpAimlapiByApiKey({
      apiKey: 'key_test',
      paymentSessionId: 'payment-id',
      amountUsd: '25',
      noOpen: true,
    }),
  ).rejects.toThrow('valid HTTPS checkout URL')
})

test('terminal resumed-session errors clear retained checkout state', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  globalThis.fetch = mock(async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
  const sessions: string[] = []

  await expect(
    topUpAimlapiByApiKey({
      apiKey: 'key_test',
      paymentSessionId: 'payment-id',
      resumeSessionToken: 'dead-session',
      amountUsd: '25',
      noOpen: true,
      onSession: session => {
      sessions.push(session)
    },
    }),
  ).rejects.toThrow('404')
  expect(sessions).toEqual([''])
})

test('dead sessions observed while polling are cleared immediately', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v3/partner-checkout/sessions')) {
      return sessionJson({ sessionToken: 'session', status: 'pending_auth' })
    }
    if (url.endsWith('/v2/billing/topup')) {
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test/pay' },
        partnerCheckout: { id: 'sess_test', partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ', partnerName: null, userId: null, amountUsdMinor: null, issuedKeyId: null, returnUrl: null, sessionToken: 'session', status: 'pending_payment' },
      })
    }
    return sessionJson({ sessionToken: 'session', status: 'expired' })
  }) as unknown as typeof fetch
  const sessions: string[] = []

  await expect(
    topUpAimlapiByApiKey({
      apiKey: 'key_test',
      paymentSessionId: 'payment-id',
      amountUsd: '25',
      noOpen: true,
      onSession: session => {
      sessions.push(session)
    },
    }),
  ).rejects.toThrow('Payment expired')
  expect(sessions).toEqual(['session', ''])
})

test('aborting during polling stops requests and preserves the retained session', async () => {
  const controller = new AbortController()
  let getCount = 0
  globalThis.fetch = mock(async () => {
    getCount += 1
    controller.abort()
    return sessionJson({ sessionToken: 'session', status: 'pending_payment' })
  }) as unknown as typeof fetch
  const client = new AimlapiClient({
    authBaseUrl: 'https://auth.example.test',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.example.test/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  })
  const sessions: string[] = []

  await expect(
    pollUntilPaid(client, 'session', controller.signal, value => { sessions.push(value) }),
  ).rejects.toThrow()
  // Aborted before the next poll: exactly one GET, and the session is not cleared.
  expect(getCount).toBe(1)
  expect(sessions).toEqual([])
})

test('terminal API errors observed while polling clear retained checkout state', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v3/partner-checkout/sessions')) {
      return sessionJson({ sessionToken: 'session', status: 'pending_auth' })
    }
    if (url.endsWith('/v2/billing/topup')) {
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test/pay' },
        partnerCheckout: { id: 'sess_test', partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ', partnerName: null, userId: null, amountUsdMinor: null, issuedKeyId: null, returnUrl: null, sessionToken: 'session', status: 'pending_payment' },
      })
    }
    return new Response('gone', { status: 410 })
  }) as unknown as typeof fetch
  const sessions: string[] = []

  await expect(
    topUpAimlapiByApiKey({
      apiKey: 'key_test',
      paymentSessionId: 'payment-id',
      amountUsd: '25',
      noOpen: true,
      onSession: session => {
      sessions.push(session)
    },
    }),
  ).rejects.toThrow('410')
  expect(sessions).toEqual(['session', ''])
})

test('a terminal poll error awaits onSession before rejecting, not racing ahead of receipt cleanup', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.example.test/v1'
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v3/partner-checkout/sessions')) {
      return sessionJson({ sessionToken: 'session', status: 'pending_auth' })
    }
    if (url.endsWith('/v2/billing/topup')) {
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test/pay' },
        partnerCheckout: {
          id: 'sess_test',
          partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
          partnerName: null,
          userId: null,
          amountUsdMinor: null,
          issuedKeyId: null,
          returnUrl: null,
          sessionToken: 'session',
          status: 'pending_payment',
        },
      })
    }
    return new Response('gone', { status: 410 })
  }) as unknown as typeof fetch

  let cleanupSettled = false
  await expect(
    topUpAimlapiByApiKey({
      apiKey: 'key_test',
      paymentSessionId: 'payment-id',
      amountUsd: '25',
      noOpen: true,
      onSession: async session => {
        if (!session) {
          // Simulate a contended receipt-cleanup lock, like
          // resetAimlapiCheckoutSessionAsync/clearAimlapiTopupStateAsync in
          // the real GUI caller.
          await new Promise(resolve => setTimeout(resolve, 30))
          cleanupSettled = true
        }
      },
    }),
  ).rejects.toThrow('410')

  // If the poll surfaced the terminal error without awaiting onSession('')
  // first, this promise would already have rejected before the 30ms cleanup
  // had a chance to finish — a caller retrying right after rejection would
  // then still observe the stale, not-yet-cleared receipt.
  expect(cleanupSettled).toBe(true)
})

test('polling retries a transient transport failure', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  let attempts = 0
  globalThis.fetch = mock(async () => {
    attempts += 1
    if (attempts === 1) throw new TypeError('temporary connection reset')
    return sessionJson({ sessionToken: 'session', status: 'paid' })
  }) as unknown as typeof fetch
  const client = new AimlapiClient({
    authBaseUrl: 'https://auth.example.test',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.example.test/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  })

  await expect(pollUntilPaid(client, 'session')).resolves.toEqual(
    expect.objectContaining({ status: 'paid' }),
  )
  expect(attempts).toBe(2)
})

test('polling retains and retries the same session after a rate limit', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  let attempts = 0
  globalThis.fetch = mock(async () => {
    attempts += 1
    if (attempts === 1) return new Response('rate limited', { status: 429 })
    return sessionJson({ sessionToken: 'session', status: 'paid' })
  }) as unknown as typeof fetch
  const client = new AimlapiClient({
    authBaseUrl: 'https://auth.example.test',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.example.test/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  })
  const sessions: string[] = []

  await expect(
    pollUntilPaid(client, 'session', undefined, value => { sessions.push(value) }),
  ).resolves.toEqual(expect.objectContaining({ status: 'paid' }))
  expect(attempts).toBe(2)
  expect(sessions).toEqual([])
})

test('by-key billing stays on the endpoint that validated the key', async () => {
  process.env.AIMLAPI_APP_URL = 'https://app.example.test'
  process.env.AIMLAPI_INFERENCE_URL = 'https://override.example.test/v1'
  const calls: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/v3/partner-checkout/sessions')) {
      return sessionJson({ sessionToken: 'session', status: 'pending_auth' })
    }
    if (url.endsWith('/v2/billing/topup')) {
      return Response.json({
        checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test/pay' },
        partnerCheckout: { id: 'sess_test', partnerId: 'part_62yQoGYDq4Yqnrj2R1iGrDNJ', partnerName: null, userId: null, amountUsdMinor: null, issuedKeyId: null, returnUrl: null, sessionToken: 'session', status: 'pending_payment' },
      })
    }
    return sessionJson({ sessionToken: 'session', status: 'paid' })
  }) as unknown as typeof fetch

  await topUpAimlapiByApiKey({
    apiKey: 'production-key',
    inferenceBaseUrl: 'https://api.aimlapi.com/v1',
    paymentSessionId: 'payment-id',
    amountUsd: '25',
    noOpen: true,
  })
  expect(calls).toContain('https://api.aimlapi.com/v2/billing/topup')
  expect(calls).not.toContain('https://override.example.test/v2/billing/topup')
})

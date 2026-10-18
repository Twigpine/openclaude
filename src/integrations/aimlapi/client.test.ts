import { afterEach, expect, mock, test } from 'bun:test'

import { AimlapiApiError, AimlapiClient } from './client.js'
import type { AimlapiEndpoints } from './config.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

// The default *.example.test hosts stand in for a user-overridden (non-aimlapi)
// deployment: attribution headers must be withheld from them.
const endpoints: AimlapiEndpoints = {
  authBaseUrl: 'https://auth.example.test',
  appBaseUrl: 'https://app.example.test',
  payBaseUrl: 'https://pay.example.test',
  inferenceBaseUrl: 'https://api.example.test/v1',
  verificationBaseUrl: 'https://front.example.test',
}

// Production AI/ML API hosts, which DO receive the mandatory attribution headers.
const canonicalEndpoints: AimlapiEndpoints = {
  authBaseUrl: 'https://auth.aimlapi.com',
  appBaseUrl: 'https://app.aimlapi.com',
  payBaseUrl: 'https://pay.aimlapi.com',
  inferenceBaseUrl: 'https://api.aimlapi.com/v1',
  verificationBaseUrl: 'https://aimlapi.com/app',
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A structurally complete pay/top-up receipt, as the backend contract defines. */
function payReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkout: { providerSessionId: 'provider', payUrl: 'https://checkout.test' },
    partnerCheckout: {
      id: 'sess_1',
      sessionToken: 'session',
      partnerId: 'part_1',
      partnerName: 'OpenClaude',
      userId: 1,
      amountUsdMinor: 2500,
      status: 'pending_payment',
      issuedKeyId: null,
      returnUrl: null,
    },
    ...overrides,
  }
}

test('passwordless onboarding methods use the current backend contracts', async () => {
  const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = []
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      init,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    if (url.endsWith('/v1/auth/account') && init?.method === 'PATCH') {
      return jsonResponse({ action: 'sign-in' })
    }
    if (url.endsWith('/code/verify')) return jsonResponse({ token: 'bearer', exp: 1 })
    if (url.endsWith('/passwordless')) return jsonResponse({ token: 'new-bearer', exp: 2 })
    if (url.endsWith('/v1/keys')) return jsonResponse({ key: 'key_test', id: 'id_test' })
    if (url.endsWith('/billing/balance')) {
      return jsonResponse({ balance: 10, lowBalance: true, lowBalanceThreshold: 20 })
    }
    return new Response('', { status: 204 })
  }) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  expect(await client.checkAccount('user@example.com')).toEqual({ action: 'sign-in' })
  await client.sendSignInCode('user@example.com')
  expect(await client.verifySignInCode('user@example.com', '123456')).toEqual({
    token: 'bearer',
    exp: 1,
  })
  expect(await client.createPasswordlessAccount('new@example.com')).toEqual({
    token: 'new-bearer',
    exp: 2,
  })
  expect(await client.createKey('bearer', 'OpenClaude CLI')).toEqual({
    key: 'key_test',
    id: 'id_test',
  })
  expect((await client.getBalance('key_test')).lowBalance).toBe(true)

  expect(calls.map(call => [call.init?.method, call.url, call.body])).toEqual([
    ['PATCH', 'https://auth.example.test/v1/auth/account', { email: 'user@example.com' }],
    ['POST', 'https://auth.example.test/v1/auth/sign-in/code', { email: 'user@example.com' }],
    ['POST', 'https://auth.example.test/v1/auth/sign-in/code/verify', { email: 'user@example.com', code: '123456' }],
    ['POST', 'https://auth.example.test/v1/auth/account/passwordless', { email: 'new@example.com' }],
    ['POST', 'https://app.example.test/v1/keys', { name: 'OpenClaude CLI' }],
    ['GET', 'https://api.example.test/v1/billing/balance', undefined],
  ])
})

test('pay only sends autoTopUp when it is enabled', async () => {
  const bodies: unknown[] = []
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)
    return jsonResponse(payReceipt())
  }) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  await client.pay('bearer', 'session', {
    amountUsdMinor: 2500,
    paymentSessionId: 'payment-id',
  })
  await client.pay('bearer', 'session', {
    amountUsdMinor: 2500,
    paymentSessionId: 'payment-id',
    autoTopUp: true,
  })
  expect(bodies).toEqual([
    { amountUsdMinor: 2500, paymentSessionId: 'payment-id', method: 'card' },
    { amountUsdMinor: 2500, paymentSessionId: 'payment-id', method: 'card', autoTopUp: true },
  ])
})

test('pay omits an absent payment session id and always sends card', async () => {
  // Card is the only rail; the field is always present and there is no payment
  // session id here, so the body carries just the amount + return URL + card.
  const bodies: unknown[] = []
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)
    return jsonResponse(payReceipt())
  }) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  await client.pay('bearer', 'session', {
    amountUsdMinor: 2500,
    successUrl: 'https://ok.test',
  })
  expect(bodies).toEqual([
    { amountUsdMinor: 2500, method: 'card', successUrl: 'https://ok.test' },
  ])
})

test('pay and topUpByKey reject a malformed checkout receipt', async () => {
  // The charge is already requested by the time this returns, so a receipt that
  // is not fully usable must fail loudly instead of being opened as a URL and
  // polled until timeout.
  for (const receipt of [
    { checkout: { payUrl: true } },
    { checkout: { providerSessionId: 'provider', payUrl: 42 } },
    { checkout: { providerSessionId: '', payUrl: 'https://checkout.test' } },
    payReceipt({ partnerCheckout: { sessionToken: 'session' } }),
  ]) {
    globalThis.fetch = mock(async () => jsonResponse(receipt)) as unknown as typeof fetch
    const client = new AimlapiClient(endpoints)

    await expect(
      client.pay('bearer', 'session', { amountUsdMinor: 2500, paymentSessionId: 'p' }),
    ).rejects.toThrow('invalid checkout')
    await expect(
      client.topUpByKey('key', {
        sessionToken: 'session',
        amountUsdMinor: 2500,
        paymentSessionId: 'p',
      }),
    ).rejects.toThrow('invalid checkout')
  }

  // `payUrl: null` is a valid receipt - the backend may defer the URL.
  globalThis.fetch = mock(async () =>
    jsonResponse(payReceipt({ checkout: { providerSessionId: 'provider', payUrl: null } })),
  ) as unknown as typeof fetch
  const client = new AimlapiClient(endpoints)
  expect(
    (await client.pay('bearer', 'session', { amountUsdMinor: 2500, paymentSessionId: 'p' }))
      .checkout.payUrl,
  ).toBeNull()
})

test('sendSignInCode accepts a non-empty plain-text acknowledgement', async () => {
  // The code has already been delivered by the time this returns, so a
  // non-JSON acknowledgement must not surface as an error and push the user
  // into a retry that can invalidate or rate-limit the one-time code.
  const requests: Array<{ method?: string; url: string; body?: unknown }> = []
  for (const body of ['code sent', '', 'OK']) {
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          method: init?.method,
          url: String(input),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        })
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      },
    ) as unknown as typeof fetch
    const client = new AimlapiClient(endpoints)
    expect(await client.sendSignInCode('user@example.com')).toBeUndefined()
  }

  // Accepting any successful body must not mask a wrong endpoint or payload.
  expect(requests).toEqual(
    Array.from({ length: 3 }, () => ({
      method: 'POST',
      url: `${endpoints.authBaseUrl}/v1/auth/sign-in/code`,
      body: { email: 'user@example.com' },
    })),
  )

  // A non-2xx acknowledgement is still an error.
  globalThis.fetch = mock(
    async () => new Response('rate limited', { status: 429 }),
  ) as unknown as typeof fetch
  const client = new AimlapiClient(endpoints)
  await expect(client.sendSignInCode('user@example.com')).rejects.toBeInstanceOf(
    AimlapiApiError,
  )
})

test('a receipt whose payUrl is not HTTPS is rejected at the response boundary', async () => {
  // `payUrl` must be HTTPS (it is opened in a browser and matches announceCheckout).
  // Rejecting a cleartext/unopenable URL here stops the session being retained and
  // then polled for 20 minutes with no usable checkout link after the charge.
  for (const payUrl of [
    'not-a-url',
    'javascript:alert(1)',
    'file:///tmp/checkout',
    'ftp://checkout.test/pay',
    'http://checkout.test/pay',
  ]) {
    globalThis.fetch = mock(async () =>
      jsonResponse(payReceipt({ checkout: { providerSessionId: 'provider', payUrl } })),
    ) as unknown as typeof fetch
    const client = new AimlapiClient(endpoints)
    await expect(
      client.pay('bearer', 'session', { amountUsdMinor: 2500, paymentSessionId: 'p' }),
    ).rejects.toThrow('invalid checkout')
  }
})

test('the one-time sign-in code is redacted from a reflected error', async () => {
  // An auth service that echoes the invalid code must not leak it through
  // `error.body`, which CLI handlers print verbatim.
  globalThis.fetch = mock(
    async () =>
      new Response('{"error":"code 123456 is invalid"}', { status: 400 }),
  ) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  const error = await client
    .verifySignInCode('user@example.com', '123456')
    .then(() => null, (reason: unknown) => reason)

  expect(error).toBeInstanceOf(AimlapiApiError)
  expect((error as AimlapiApiError).body).not.toContain('123456')
  expect((error as AimlapiApiError).body).toContain('[REDACTED]')
})

test('exported result types reject malformed required fields', async () => {
  const client = new AimlapiClient(endpoints)

  // `exp` is part of AuthResult, so a missing/non-numeric value must not pass.
  for (const auth of [{ token: 'bearer' }, { token: 'bearer', exp: 'soon' }]) {
    globalThis.fetch = mock(async () => jsonResponse(auth)) as unknown as typeof fetch
    await expect(
      client.verifySignInCode('user@example.com', '123456'),
    ).rejects.toThrow('did not return an auth token')
  }

  // Nullable-but-required session fields are still typed, so validate them.
  for (const override of [
    { partnerName: 42 },
    { userId: 'one' },
    { amountUsdMinor: '2500' },
    { issuedKeyId: 7 },
    { returnUrl: false },
  ]) {
    const session = { ...(payReceipt().partnerCheckout as object), ...override }
    globalThis.fetch = mock(async () => jsonResponse(session)) as unknown as typeof fetch
    await expect(client.getSession('session-token')).rejects.toThrow('invalid session')
  }
})

test('checkAccount rejects an unsupported account action', async () => {
  // `action` selects the onboarding branch, so an unknown value must not cross
  // the client boundary as an impossible typed value.
  globalThis.fetch = mock(async () =>
    jsonResponse({ action: 'disabled' }),
  ) as unknown as typeof fetch
  const client = new AimlapiClient(endpoints)
  await expect(client.checkAccount('user@example.com')).rejects.toThrow(
    'invalid account response',
  )

  globalThis.fetch = mock(async () =>
    jsonResponse({ action: 'sign-up', provider: 'google' }),
  ) as unknown as typeof fetch
  expect(await client.checkAccount('user@example.com')).toEqual({
    action: 'sign-up',
    provider: 'google',
  })
})

test('a non-success body is redacted before it reaches the error', async () => {
  // CLI handlers print `error.body` verbatim, and a proxy can reflect the
  // credential back in a 4xx/5xx payload.
  globalThis.fetch = mock(
    async () =>
      new Response('{"error":"bad token session-secret for bearer-secret"}', {
        status: 401,
      }),
  ) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  const error = await client
    .exchange('bearer-secret', 'session-secret')
    .then(() => null, (reason: unknown) => reason)

  expect(error).toBeInstanceOf(AimlapiApiError)
  const apiError = error as AimlapiApiError
  expect(apiError.body).not.toContain('session-secret')
  expect(apiError.body).not.toContain('bearer-secret')
  expect(apiError.body).toContain('[REDACTED]')
})

test('a JSON-escaped credential is redacted from a reflected body', async () => {
  // A backend reflecting a credential usually re-serializes it, so the body
  // carries the JSON-escaped form rather than the raw one.
  const password = 'p\\q"r'
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ error: `bad password ${password}` }), {
        status: 401,
      }),
  ) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  const error = await client
    .verifySignInCode('user@example.com', password)
    .then(() => null, (reason: unknown) => reason)

  expect(error).toBeInstanceOf(AimlapiApiError)
  const body = (error as AimlapiApiError).body
  expect(body).not.toContain(JSON.stringify(password).slice(1, -1))
  expect(body).not.toContain(password)
  expect(body).toContain('[REDACTED]')
})

test('overlapping secrets are redacted longest-first', async () => {
  // The bearer is a prefix of the session token; redacting it first would leave
  // the token's tail behind.
  globalThis.fetch = mock(
    async () => new Response('{"error":"abc123 rejected"}', { status: 403 }),
  ) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  const error = await client
    .exchange('abc', 'abc123')
    .then(() => null, (reason: unknown) => reason)

  expect(error).toBeInstanceOf(AimlapiApiError)
  const body = (error as AimlapiApiError).body
  expect(body).not.toContain('abc123')
  expect(body).not.toContain('123')
  expect(body).toContain('[REDACTED]')
})

test('a cancelled request does not leak its token through the error', async () => {
  const controller = new AbortController()
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () =>
          reject(
            new DOMException(
              'The operation was aborted: https://app.example.test/v3/partner-checkout/sessions/session-secret',
              'AbortError',
            ),
          ),
        { once: true },
      )
    })
  }) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  const pending = client.getSession('session-secret', controller.signal)
  controller.abort()
  const error = await pending.then(() => null, (reason: unknown) => reason)

  // Cancellation identity is preserved for callers that branch on it...
  expect((error as Error).name).toBe('AbortError')
  // ...but the token never reaches the message.
  expect((error as Error).message).not.toContain('session-secret')
  expect((error as Error).message).toContain('[REDACTED]')
})

test('a short session token is still redacted from transport errors', async () => {
  // The path-segment scan skips short segments, so tokens are redacted from an
  // explicit secret list instead of relying on their length.
  globalThis.fetch = mock(async () => {
    throw new Error('connect ECONNREFUSED https://app.example.test/v3/partner-checkout/sessions/abc')
  }) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  const error = await client
    .getSession('abc')
    .then(() => null, (reason: unknown) => reason)

  expect(error).toBeInstanceOf(AimlapiApiError)
  expect((error as AimlapiApiError).message).not.toContain('abc')
  expect((error as AimlapiApiError).message).toContain('[REDACTED]')
})

test('topUpByKey uses the v2 billing endpoint and API key bearer', async () => {
  let seenUrl = ''
  let seenHeaders = new Headers()
  let seenBody: unknown
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input)
    seenHeaders = new Headers(init?.headers)
    seenBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return jsonResponse(payReceipt())
  }) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  await client.topUpByKey('key_test', {
    sessionToken: 'session',
    amountUsdMinor: 2500,
    paymentSessionId: 'payment-id',
    autoTopUp: true,
  })

  expect(seenUrl).toBe('https://api.example.test/v2/billing/topup')
  expect(seenHeaders.get('Authorization')).toBe('Bearer key_test')
  expect(seenBody).toEqual({
    sessionToken: 'session',
    amountUsdMinor: 2500,
    paymentSessionId: 'payment-id',
    autoTopUp: true,
  })
})

test('typed requests reject an empty successful response', async () => {
  globalThis.fetch = mock(async () => new Response('', { status: 204 })) as unknown as typeof fetch
  const client = new AimlapiClient(endpoints)
  await expect(client.getBalance('key_test')).rejects.toThrow('returned empty body')
})

test('getBalance rejects malformed successful payloads', async () => {
  const client = new AimlapiClient(endpoints)
  for (const payload of [
    {},
    { balance: 25, lowBalance: false },
    { balance: '25', lowBalance: false, lowBalanceThreshold: 20 },
    { balance: 25, lowBalance: 'false', lowBalanceThreshold: 20 },
    { balance: 25, lowBalance: false, lowBalanceThreshold: null },
  ]) {
    globalThis.fetch = mock(async () => jsonResponse(payload)) as unknown as typeof fetch
    await expect(client.getBalance('key_test')).rejects.toThrow(
      'returned invalid balance response',
    )
  }
})

test('session tokens are excluded from HTTP and network errors', async () => {
  const client = new AimlapiClient(endpoints)
  const token = 'session-secret-token'

  globalThis.fetch = mock(async () => new Response('failed', { status: 500 })) as unknown as typeof fetch
  let httpError: unknown
  try {
    await client.getSession(token)
  } catch (error) {
    httpError = error
  }
  expect(httpError).toBeInstanceOf(Error)
  expect((httpError as Error).message).toContain('https://app.example.test')
  expect((httpError as Error).message).not.toContain(token)

  globalThis.fetch = mock(async () => {
    throw new Error(`transport failed for ${token}`)
  }) as unknown as typeof fetch
  let networkError: unknown
  try {
    await client.exchange('bearer', token)
  } catch (error) {
    networkError = error
  }
  expect(networkError).toBeInstanceOf(Error)
  expect((networkError as Error).message).not.toContain(token)
})

test('response bodies are capped before decoding or surfacing errors', async () => {
  globalThis.fetch = mock(
    async () => new Response('x'.repeat((1 << 20) + 1), { status: 502 }),
  ) as unknown as typeof fetch
  const client = new AimlapiClient(endpoints)
  await expect(client.getBalance('key_test')).rejects.toThrow(
    'response body exceeds 1048576 bytes',
  )
})

test('token-producing methods reject an empty token', async () => {
  globalThis.fetch = mock(async () => jsonResponse({ token: '', exp: 1 })) as unknown as typeof fetch
  const client = new AimlapiClient(endpoints)
  await expect(client.verifySignInCode('user@example.com', '123456')).rejects.toThrow(
    'did not return an auth token',
  )
  await expect(client.createPasswordlessAccount('user@example.com')).rejects.toThrow(
    'did not return an auth token',
  )
})

test('a request forwards the abort signal to fetch and rejects when cancelled', async () => {
  const controller = new AbortController()
  let forwardedSignal: AbortSignal | undefined
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    forwardedSignal = init?.signal ?? undefined
    // Model a transport that only settles when the request is aborted.
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true },
      )
    })
  }) as unknown as typeof fetch

  const client = new AimlapiClient(endpoints)
  const pending = client.getSession('resume-token', controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow()
  // The signal reached the transport layer and observed the cancellation.
  expect(forwardedSignal).toBeInstanceOf(AbortSignal)
  expect(forwardedSignal?.aborted).toBe(true)
})

test('session methods reject a malformed or empty success payload', async () => {
  // A structurally-invalid 200 must surface as a non-terminal (status 200)
  // error rather than a session with an unknown status, so callers never clear
  // the retained payment identity or take an ambiguous retry on it.
  const client = new AimlapiClient(endpoints)

  // Empty object: passes the request-level object guard, rejected by the
  // session shape check (no valid status).
  globalThis.fetch = mock(async () => jsonResponse({})) as unknown as typeof fetch
  const emptyError = await client.getSession('resume-token').catch((error: unknown) => error)
  expect(emptyError).toBeInstanceOf(AimlapiApiError)
  expect(emptyError).toHaveProperty('status', 200)

  // null / non-object: rejected by the request-level guard.
  globalThis.fetch = mock(async () => jsonResponse(null)) as unknown as typeof fetch
  const nullError = await client.getSession('resume-token').catch((error: unknown) => error)
  expect(nullError).toBeInstanceOf(AimlapiApiError)
  expect(nullError).toHaveProperty('status', 200)

  // Unknown status: object with a status outside the allowlist.
  globalThis.fetch = mock(async () =>
    jsonResponse({ sessionToken: 'session', status: 'nonsense' }),
  ) as unknown as typeof fetch
  const badStatusError = await client
    .createSession({ partnerId: 'part_x' })
    .catch((error: unknown) => error)
  expect(badStatusError).toBeInstanceOf(AimlapiApiError)
  expect(badStatusError).toHaveProperty('status', 200)
})

test('typed methods reject wrong-typed success fields without a raw TypeError', async () => {
  const client = new AimlapiClient(endpoints)

  // A 2xx payload with a numeric token/key/apiKey must not reach .trim().
  globalThis.fetch = mock(async () => jsonResponse({ token: 1 })) as unknown as typeof fetch
  await expect(client.verifySignInCode('user@example.com', '123456')).rejects.toThrow(
    'did not return an auth token',
  )
  await expect(client.createPasswordlessAccount('user@example.com')).rejects.toThrow(
    'did not return an auth token',
  )

  globalThis.fetch = mock(async () => jsonResponse({ key: 1 })) as unknown as typeof fetch
  await expect(client.createKey('bearer', 'OpenClaude CLI')).rejects.toThrow(
    'did not return an API key',
  )
  // Key without its required id is an incomplete receipt and must be rejected.
  globalThis.fetch = mock(async () => jsonResponse({ key: 'k_only' })) as unknown as typeof fetch
  await expect(client.createKey('bearer', 'OpenClaude CLI')).rejects.toThrow(
    'did not return an API key',
  )

  globalThis.fetch = mock(async () => jsonResponse({ apiKey: 1 })) as unknown as typeof fetch
  const exchangeError = await client.exchange('bearer', 'session').catch((e: unknown) => e)
  expect(exchangeError).toBeInstanceOf(AimlapiApiError)
  expect(exchangeError).toHaveProperty('status', 200)

  // apiKey without its required apiKeyId is an incomplete exchange receipt.
  globalThis.fetch = mock(async () =>
    jsonResponse({ apiKey: 'k_only' }),
  ) as unknown as typeof fetch
  const partialExchange = await client.exchange('bearer', 'session').catch((e: unknown) => e)
  expect(partialExchange).toBeInstanceOf(AimlapiApiError)
  expect(partialExchange).toHaveProperty('status', 200)

  globalThis.fetch = mock(async () => jsonResponse({ action: 1 })) as unknown as typeof fetch
  const accountError = await client.checkAccount('user@example.com').catch((e: unknown) => e)
  expect(accountError).toBeInstanceOf(AimlapiApiError)
  expect(accountError).toHaveProperty('status', 200)
})

test('every request to an AI/ML API host carries the mandatory attribution headers', async () => {
  let headers = new Headers()
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    headers = new Headers(init?.headers)
    return jsonResponse({ action: 'sign-in' })
  }) as unknown as typeof fetch

  const client = new AimlapiClient(canonicalEndpoints)
  await client.checkAccount('user@example.com')

  // Both headers are mandatory on EVERY aimlapi request (auth / checkout /
  // catalog): the integration source and the partner id.
  expect(headers.get('X-AIMLAPI-Source')).toBe('agent/openclaude')
  const partner = headers.get('X-AIMLAPI-Partner-ID')
  expect(partner).toBeTruthy()
  expect(partner?.startsWith('part_')).toBe(true)
})

test('attribution headers are withheld from an overridden (non-aimlapi) inference host', async () => {
  let headers = new Headers()
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    headers = new Headers(init?.headers)
    return jsonResponse({ balance: 10, lowBalance: false, lowBalanceThreshold: 20 })
  }) as unknown as typeof fetch

  // inferenceBaseUrl points at api.example.test (a user proxy). The balance probe
  // must not leak OpenClaude's partner/source identity to a third-party host,
  // mirroring the inference/catalog stripping contract.
  const client = new AimlapiClient(endpoints)
  await client.getBalance('key_test')

  expect(headers.get('X-AIMLAPI-Source')).toBeNull()
  expect(headers.get('X-AIMLAPI-Partner-ID')).toBeNull()
  // The caller's own credential still rides — only OpenClaude attribution is gated.
  expect(headers.get('Authorization')).toBe('Bearer key_test')
})

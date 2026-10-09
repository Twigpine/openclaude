import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  AIMLAPI_MANAGED_ATTRIBUTION_HEADER_NAMES,
  DEFAULT_PARTNER_ID,
  buildPartnerCheckoutReturnUrls,
  buildPartnerReturnUrl,
  isCanonicalAimlapiInferenceBaseUrl,
  isTrustedAimlapiRequestUrl,
  resolveAimlapiAttributionHeaders,
  resolvePartnerId,
  resolveEndpoints,
  withResolvedPartnerHeader,
} from './config.js'

const envNames = [
  'AIMLAPI_AUTH_URL',
  'AIMLAPI_APP_URL',
  'AIMLAPI_PAY_URL',
  'AIMLAPI_INFERENCE_URL',
  'AIMLAPI_VERIFICATION_BASE_URL',
  'AIMLAPI_RETURN_URL',
  'AIMLAPI_PARTNER_ID',
] as const
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))

// Clear ambient AIMLAPI overrides before every test so default/fallback
// assertions never depend on the invoking environment; the runner's original
// values are restored in teardown.
beforeEach(() => {
  for (const name of envNames) delete process.env[name]
})

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('resolveEndpoints returns the production endpoints', () => {
  expect(resolveEndpoints()).toEqual({
    authBaseUrl: 'https://auth.aimlapi.com',
    appBaseUrl: 'https://app.aimlapi.com',
    payBaseUrl: 'https://pay.aimlapi.com',
    inferenceBaseUrl: 'https://api.aimlapi.com/v1',
    verificationBaseUrl: 'https://aimlapi.com/app',
  })
})

test('partner id is fixed and ignores the env override', () => {
  process.env.AIMLAPI_PARTNER_ID = 'part_override'
  // The partner id is locked to OpenClaude's attribution id; an env override is
  // intentionally ignored so rebate attribution can never be redirected.
  expect(resolvePartnerId()).toBe('part_62yQoGYDq4Yqnrj2R1iGrDNJ')
  expect(
    withResolvedPartnerHeader({
      'x-aimlapi-partner-id': 'part_catalog',
      'X-Title': 'OpenClaude',
    }),
  ).toEqual({
    'X-AIMLAPI-Partner-ID': 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    'X-Title': 'OpenClaude',
  })
})

test('canonical endpoint check excludes proxies and look-alike paths', () => {
  // Exactly the production endpoint, with at most one trailing slash.
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/v1')).toBe(true)
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/v1/')).toBe(true)
  // Host/protocol compare case-insensitively via the parsed origin.
  expect(isCanonicalAimlapiInferenceBaseUrl('https://API.AIMLAPI.COM/v1')).toBe(true)

  // Distinct paths must NOT receive the ambient credential.
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/V1')).toBe(false)
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/v1////')).toBe(false)
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/v1/models')).toBe(false)
  // A different protocol/host is never canonical.
  expect(isCanonicalAimlapiInferenceBaseUrl('http://api.aimlapi.com/v1')).toBe(false)
  expect(isCanonicalAimlapiInferenceBaseUrl('https://proxy.example.test/v1')).toBe(false)
  // A query, fragment, bare delimiter, or embedded credential is non-canonical:
  // written verbatim as OPENAI_BASE_URL it would break the shim's path append.
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/v1?x=1')).toBe(false)
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/v1#x')).toBe(false)
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/v1?')).toBe(false)
  expect(isCanonicalAimlapiInferenceBaseUrl('https://api.aimlapi.com/v1#')).toBe(false)
  expect(isCanonicalAimlapiInferenceBaseUrl('https://user:pass@api.aimlapi.com/v1')).toBe(false)
  // Garbage input fails closed.
  expect(isCanonicalAimlapiInferenceBaseUrl('not-a-url')).toBe(false)
})

test('checkout return URLs require a credential-free HTTPS base', () => {
  const { successUrl, cancelUrl } = buildPartnerCheckoutReturnUrls(
    'https://pay.aimlapi.com',
    'sess_1',
  )
  expect(successUrl).toContain('https://pay.aimlapi.com/checkout?')
  expect(successUrl).toContain('sessionToken=sess_1')
  expect(cancelUrl).toContain('checkout=cancel')
  // These URLs carry the resumable session token, so a cleartext or credentialed
  // base must be rejected before a session is created.
  expect(() => buildPartnerCheckoutReturnUrls('http://pay.aimlapi.com', 'sess_1')).toThrow(
    /https/i,
  )
  expect(() =>
    buildPartnerCheckoutReturnUrls('https://user:pass@pay.aimlapi.com', 'sess_1'),
  ).toThrow(/credential/i)
  // A query string or fragment would swallow the appended checkout params.
  expect(() =>
    buildPartnerCheckoutReturnUrls('https://pay.aimlapi.com/#resume', 'sess_1'),
  ).toThrow(/query string or fragment/i)
  expect(() =>
    buildPartnerCheckoutReturnUrls('https://pay.aimlapi.com/?x=1', 'sess_1'),
  ).toThrow(/query string or fragment/i)
  // Bare `?`/`#` delimiters leave url.search/url.hash empty but still corrupt the
  // appended checkout params, so they must be rejected too.
  expect(() => buildPartnerCheckoutReturnUrls('https://pay.aimlapi.com/?', 'sess_1')).toThrow(
    /query string or fragment/i,
  )
  expect(() => buildPartnerCheckoutReturnUrls('https://pay.aimlapi.com/#', 'sess_1')).toThrow(
    /query string or fragment/i,
  )
  expect(() => buildPartnerCheckoutReturnUrls('not-a-url', 'sess_1')).toThrow()
})

test('the browser return URL ignores a non-HTTPS override', () => {
  process.env.AIMLAPI_RETURN_URL = 'http://landing.example.test'
  expect(buildPartnerReturnUrl('https://front.example.test')).toBe('https://front.example.test')
  process.env.AIMLAPI_RETURN_URL = 'https://landing.example.test'
  expect(buildPartnerReturnUrl('https://front.example.test')).toBe('https://landing.example.test')
  // A bare `?`/`#` delimiter is ignored like any other malformed base.
  process.env.AIMLAPI_RETURN_URL = 'https://landing.example.test/#'
  expect(buildPartnerReturnUrl('https://front.example.test')).toBe('https://front.example.test')
  delete process.env.AIMLAPI_RETURN_URL
  expect(buildPartnerReturnUrl('http://front.example.test')).toBe('https://aimlapi.com/app')
})

test('trusted-host gate accepts only https aimlapi.com hosts', () => {
  // Production + staging aimlapi hosts (any path) are trusted.
  expect(isTrustedAimlapiRequestUrl('https://auth.aimlapi.com/v1/auth/account')).toBe(true)
  expect(isTrustedAimlapiRequestUrl('https://api.aimlapi.com/v1/billing/balance')).toBe(true)
  expect(isTrustedAimlapiRequestUrl('https://aimlapi.com/app')).toBe(true)
  expect(isTrustedAimlapiRequestUrl('https://auth.staging.aimlapi.com/v1')).toBe(true)
  // A user proxy, look-alike hosts, and cleartext are all untrusted.
  expect(isTrustedAimlapiRequestUrl('https://proxy.example.test/v1')).toBe(false)
  expect(isTrustedAimlapiRequestUrl('https://notaimlapi.com/v1')).toBe(false)
  expect(isTrustedAimlapiRequestUrl('https://aimlapi.com.attacker.test/v1')).toBe(false)
  expect(isTrustedAimlapiRequestUrl('http://api.aimlapi.com/v1')).toBe(false)
  expect(isTrustedAimlapiRequestUrl('not-a-url')).toBe(false)
})

test('inference/catalog attribution sends both mandatory headers, stripped off-canonical', () => {
  const canonical = resolveAimlapiAttributionHeaders({}, 'https://api.aimlapi.com/v1')
  expect(canonical['X-AIMLAPI-Source']).toBe('agent/openclaude')
  expect(canonical['X-AIMLAPI-Partner-ID']).toBe('part_62yQoGYDq4Yqnrj2R1iGrDNJ')

  // A user proxy must never receive OpenClaude's partner identity or source.
  const proxied = resolveAimlapiAttributionHeaders(
    { 'X-AIMLAPI-Source': 'agent/openclaude', 'X-AIMLAPI-Partner-ID': 'part_x' },
    'https://proxy.example.test/v1',
  )
  expect(proxied['X-AIMLAPI-Source']).toBeUndefined()
  expect(proxied['X-AIMLAPI-Partner-ID']).toBeUndefined()
})

function headerNames(headers: Headers): string[] {
  const names: string[] = []
  headers.forEach((_value, name) => {
    names.push(name)
  })
  return names
}

function expectSingleManagedAttribution(
  resolved: Record<string, string>,
  expected: Record<string, string>,
): void {
  const headers = new Headers(resolved)
  for (const [name, value] of Object.entries(expected)) {
    expect(headers.get(name)).toBe(value)
  }
  const managedKeys = headerNames(headers).filter(name =>
    AIMLAPI_MANAGED_ATTRIBUTION_HEADER_NAMES.has(name),
  )
  expect(managedKeys.sort()).toEqual(
    Object.keys(expected)
      .map(name => name.toLowerCase())
      .sort(),
  )
}

test('canonical attribution drops mixed-case managed names before restamping', () => {
  // Same merge order discovery uses: caller headers first, descriptor second.
  const resolved = resolveAimlapiAttributionHeaders(
    {
      'x-aimlapi-source': 'agent/attacker',
      'x-aimlapi-partner-id': 'part_attackerOverride',
      'x-aimlapi-integration-repo': 'attacker/repo',
      'x-aimlapi-integration-version': '0.0.0-attacker',
      'http-referer': 'https://attacker.example',
      'x-title': 'Attacker',
      'X-AIMLAPI-Source': 'agent/openclaude',
      'X-AIMLAPI-Partner-ID': DEFAULT_PARTNER_ID,
      'X-AIMLAPI-Integration-Repo': 'Twigpine/openclaude',
      'X-AIMLAPI-Integration-Version': '1.2.3',
      'HTTP-Referer': 'OpenClaude',
      'X-Title': 'OpenClaude',
      'X-Tenant': 'acme',
    },
    'https://api.aimlapi.com/v1',
  )

  expect(resolved['X-Tenant']).toBe('acme')
  expectSingleManagedAttribution(resolved, {
    'X-AIMLAPI-Source': 'agent/openclaude',
    'X-AIMLAPI-Partner-ID': DEFAULT_PARTNER_ID,
    'X-AIMLAPI-Integration-Repo': 'Twigpine/openclaude',
    'X-AIMLAPI-Integration-Version': '1.2.3',
    'HTTP-Referer': 'OpenClaude',
    'X-Title': 'OpenClaude',
  })
})

test('canonical attribution restamps mixed-case caller-only fields without combining them', () => {
  const resolved = resolveAimlapiAttributionHeaders(
    {
      'x-aimlapi-source': 'agent/attacker',
      'HTTP-REFERER': 'https://attacker.example',
      'x-title': 'Attacker',
      'X-Tenant': 'acme',
    },
    'https://api.aimlapi.com/v1',
  )

  const headers = new Headers(resolved)
  expect(headers.get('x-aimlapi-source')).toBe('agent/openclaude')
  expect(headers.get('x-aimlapi-partner-id')).toBe(DEFAULT_PARTNER_ID)
  expect(headers.get('http-referer')).toBe('https://attacker.example')
  expect(headers.get('x-title')).toBe('Attacker')
  expect(headers.get('x-tenant')).toBe('acme')
  expect(headers.get('x-aimlapi-source')).not.toContain(',')
  expect(headers.get('http-referer')).not.toContain(',')
})

test('proxy attribution strips every managed name spelling and keeps X-Tenant', () => {
  const resolved = resolveAimlapiAttributionHeaders(
    {
      'x-aimlapi-source': 'agent/attacker',
      'X-AIMLAPI-Partner-ID': 'part_x',
      'x-aimlapi-integration-repo': 'attacker/repo',
      'X-AIMLAPI-Integration-Version': '0.0.0-attacker',
      'HTTP-REFERER': 'https://attacker.example',
      'x-title': 'Attacker',
      'X-Tenant': 'acme',
    },
    'https://proxy.example.test/v1',
  )

  const headers = new Headers(resolved)
  for (const name of AIMLAPI_MANAGED_ATTRIBUTION_HEADER_NAMES) {
    expect(headers.get(name)).toBeNull()
  }
  expect(headers.get('x-tenant')).toBe('acme')
  expect(Object.keys(resolved)).toEqual(['X-Tenant'])
})

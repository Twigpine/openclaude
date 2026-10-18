import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import {
  extractHits,
  customProvider,
  isPrivateHostname,
  readPositiveEnvNumber,
} from './custom.js'

async function importFreshCustomProvider() {
  const stamp = `${Date.now()}-${Math.random()}`
  return import(`./custom.ts?ts=${stamp}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('WebSearchTool/providers/custom.test.ts')
})

afterEach(() => {
  releaseSharedMutationLock()
})

// ---------------------------------------------------------------------------
// extractHits — flexible response parsing
// ---------------------------------------------------------------------------

describe('extractHits', () => {
  test('extracts from results array', () => {
    const data = { results: [{ title: 'T', url: 'https://ex.com' }] }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('T')
  })

  test('extracts from items array (Google-style)', () => {
    const data = { items: [{ title: 'T', link: 'https://ex.com' }] }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
    expect(hits[0].url).toBe('https://ex.com')
  })

  test('extracts from data array', () => {
    const data = { data: [{ title: 'T', url: 'https://ex.com' }] }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })

  test('extracts from bare array', () => {
    const data = [{ title: 'T', url: 'https://ex.com' }]
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })

  test('extracts from nested map (e.g. web.results)', () => {
    const data = {
      web: {
        results: [{ title: 'T', url: 'https://ex.com' }],
      },
    }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })

  test('extracts with explicit jsonPath', () => {
    const data = {
      response: {
        payload: [{ title: 'T', url: 'https://ex.com' }],
      },
    }
    const hits = extractHits(data, 'response.payload')
    expect(hits).toHaveLength(1)
  })

  test('returns empty for empty object', () => {
    expect(extractHits({})).toHaveLength(0)
  })

  test('returns empty for null', () => {
    expect(extractHits(null)).toHaveLength(0)
  })

  test('returns empty for no array keys', () => {
    expect(extractHits({ status: 'ok', count: 5 })).toHaveLength(0)
  })

  test('filters out hits with no title and no url', () => {
    const data = {
      results: [
        { title: 'Valid', url: 'https://ex.com' },
        { description: 'no title or url' },
      ],
    }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })

  test('extracts from organic_results (SerpAPI-style)', () => {
    const data = {
      organic_results: [{ title: 'T', link: 'https://ex.com' }],
    }
    const hits = extractHits(data)
    expect(hits).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// buildAuthHeadersForPreset — tested indirectly via env vars
// ---------------------------------------------------------------------------

describe('buildAuthHeadersForPreset auth header behavior', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ['WEB_KEY', 'WEB_AUTH_HEADER', 'WEB_AUTH_SCHEME']) {
      savedEnv[k] = process.env[k]
    }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  // We test isConfigured() which depends on WEB_SEARCH_API/WEB_PROVIDER/WEB_URL_TEMPLATE
  // and the auth behavior through the public search() interface
  test('custom provider is configured when WEB_URL_TEMPLATE is set', () => {
    process.env.WEB_URL_TEMPLATE = 'https://example.com/search?q={query}'
    const { customProvider } = require('./custom.js')
    expect(customProvider.isConfigured()).toBe(true)
    delete process.env.WEB_URL_TEMPLATE
  })

  test('custom provider is NOT configured when no env vars are set', () => {
    delete process.env.WEB_URL_TEMPLATE
    delete process.env.WEB_SEARCH_API
    delete process.env.WEB_PROVIDER
    expect(customProvider.isConfigured()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildAuthHeadersForPreset — direct tests for WEB_AUTH_HEADER / WEB_AUTH_SCHEME
// ---------------------------------------------------------------------------

describe('buildAuthHeadersForPreset direct assertions', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ['WEB_KEY', 'WEB_AUTH_HEADER', 'WEB_AUTH_SCHEME']) {
      savedEnv[k] = process.env[k]
    }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('WEB_AUTH_HEADER="" is an explicit opt-out — returns empty headers even with WEB_KEY set', () => {
    process.env.WEB_KEY = 'sk-test-123'
    process.env.WEB_AUTH_HEADER = ''
    const { buildAuthHeadersForPreset } = require('./custom.js')
    expect(buildAuthHeadersForPreset({ urlTemplate: '', queryParam: 'q', authHeader: 'Authorization' })).toEqual({})
  })

  test('WEB_AUTH_SCHEME="" strips the scheme prefix (bare key only)', () => {
    process.env.WEB_KEY = 'sk-test-123'
    process.env.WEB_AUTH_SCHEME = ''
    delete process.env.WEB_AUTH_HEADER
    const { buildAuthHeadersForPreset } = require('./custom.js')
    const result = buildAuthHeadersForPreset({ urlTemplate: '', queryParam: 'q', authHeader: 'X-Api-Key' })
    // scheme is '' so the header value should be just the key (trimmed)
    expect(result).toEqual({ 'X-Api-Key': 'sk-test-123' })
  })

  test('uses preset authHeader and authScheme when no env overrides', () => {
    process.env.WEB_KEY = 'tok-abc'
    delete process.env.WEB_AUTH_HEADER
    delete process.env.WEB_AUTH_SCHEME
    const { buildAuthHeadersForPreset } = require('./custom.js')
    const result = buildAuthHeadersForPreset({ urlTemplate: '', queryParam: 'q', authHeader: 'Authorization', authScheme: 'Bearer' })
    expect(result).toEqual({ 'Authorization': 'Bearer tok-abc' })
  })

  test('returns empty when WEB_KEY is not set', () => {
    delete process.env.WEB_KEY
    delete process.env.WEB_AUTH_HEADER
    delete process.env.WEB_AUTH_SCHEME
    const { buildAuthHeadersForPreset } = require('./custom.js')
    expect(buildAuthHeadersForPreset({ urlTemplate: '', queryParam: 'q', authHeader: 'Authorization' })).toEqual({})
  })

  test('preset authScheme="" sends bare token (Brave-style)', () => {
    process.env.WEB_KEY = 'brv-test-123'
    delete process.env.WEB_AUTH_HEADER
    delete process.env.WEB_AUTH_SCHEME
    const { buildAuthHeadersForPreset } = require('./custom.js')
    const result = buildAuthHeadersForPreset({
      urlTemplate: '',
      queryParam: 'q',
      authHeader: 'X-Subscription-Token',
      authScheme: '',
    })
    // Bare token, no leading space, no "Bearer" prefix
    expect(result).toEqual({ 'X-Subscription-Token': 'brv-test-123' })
  })

  test('preset authQueryParam suppresses auth headers entirely (Google-style)', () => {
    process.env.WEB_KEY = 'gck-test-123'
    delete process.env.WEB_AUTH_HEADER
    const { buildAuthHeadersForPreset } = require('./custom.js')
    const result = buildAuthHeadersForPreset({
      urlTemplate: '',
      queryParam: 'q',
      authQueryParam: 'key',
    })
    expect(result).toEqual({})
  })

  test('explicit WEB_AUTH_HEADER overrides authQueryParam suppression', () => {
    process.env.WEB_KEY = 'gck-test-123'
    process.env.WEB_AUTH_HEADER = 'X-Custom-Auth'
    const { buildAuthHeadersForPreset } = require('./custom.js')
    const result = buildAuthHeadersForPreset({
      urlTemplate: '',
      queryParam: 'q',
      authQueryParam: 'key',
    })
    // User overrode → still emit the header
    expect(result).toEqual({ 'X-Custom-Auth': 'Bearer gck-test-123' })
  })
})

// ---------------------------------------------------------------------------
// Built-in presets — end-to-end request shape (with mocked fetch)
// ---------------------------------------------------------------------------

describe('built-in preset request shapes', () => {
  const PRESET_ENV_KEYS = [
    'WEB_PROVIDER', 'WEB_KEY', 'WEB_AUTH_HEADER', 'WEB_AUTH_SCHEME',
    'WEB_SEARCH_API', 'WEB_URL_TEMPLATE', 'WEB_PARAMS', 'GOOGLE_CSE_ID',
  ]
  const savedEnv: Record<string, string | undefined> = {}
  const originalFetch = globalThis.fetch
  const originalConsoleWarn = console.warn
  let capturedWarnings: unknown[][] = []

  beforeEach(() => {
    for (const k of PRESET_ENV_KEYS) savedEnv[k] = process.env[k]
    capturedWarnings = []
    console.warn = (...args: unknown[]) => {
      capturedWarnings.push(args)
    }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    globalThis.fetch = originalFetch
    console.warn = originalConsoleWarn
  })

  test('google preset sends ?key= and ?cx= as query params, no auth header', async () => {
    process.env.WEB_PROVIDER = 'google'
    process.env.WEB_KEY = 'gck-test-key'
    process.env.GOOGLE_CSE_ID = 'cse-test-id'
    delete process.env.WEB_AUTH_HEADER

    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (input: any, init: any) => {
      capturedUrl = typeof input === 'string' ? input : input.toString()
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as typeof fetch

    const { customProvider: freshCustomProvider } = await importFreshCustomProvider()
    await freshCustomProvider.search({ query: 'hello world' })

    expect(capturedUrl).toContain('https://www.googleapis.com/customsearch/v1')
    expect(capturedUrl).toContain('key=gck-test-key')
    expect(capturedUrl).toContain('cx=cse-test-id')
    expect(capturedUrl).toContain('q=hello+world')
    expect(capturedHeaders.Authorization).toBeUndefined()
    expect(
      capturedWarnings.some(call =>
        String(call[0]).includes('Custom search provider is active'),
      ),
    ).toBe(true)
  })

  test('google preset throws clear error when GOOGLE_CSE_ID is missing', async () => {
    process.env.WEB_PROVIDER = 'google'
    process.env.WEB_KEY = 'gck-test-key'
    delete process.env.GOOGLE_CSE_ID

    const { customProvider } = require('./custom.js')
    await expect(customProvider.search({ query: 'q' })).rejects.toThrow(/GOOGLE_CSE_ID/)
  })

  test('google preset throws clear error when WEB_KEY is missing', async () => {
    process.env.WEB_PROVIDER = 'google'
    process.env.GOOGLE_CSE_ID = 'cse-test-id'
    delete process.env.WEB_KEY

    const { customProvider } = require('./custom.js')
    await expect(customProvider.search({ query: 'q' })).rejects.toThrow(/WEB_KEY/)
  })

  test('brave preset sends bare token in X-Subscription-Token (no Bearer prefix)', async () => {
    process.env.WEB_PROVIDER = 'brave'
    process.env.WEB_KEY = 'brv-test-key'
    delete process.env.WEB_AUTH_HEADER
    delete process.env.WEB_AUTH_SCHEME

    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: any, init: any) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 })
    }) as typeof fetch

    const { customProvider } = require('./custom.js')
    await customProvider.search({ query: 'q' })

    expect(capturedHeaders['X-Subscription-Token']).toBe('brv-test-key')
  })
})

// ---------------------------------------------------------------------------
// isPrivateHostname — SSRF guard
// ---------------------------------------------------------------------------

// Helper: route through new URL() the way validateUrl() does, so we exercise
// the same normalized hostname that production code sees.
const hostOf = (url: string) => new URL(url).hostname

describe('isPrivateHostname — IPv4', () => {
  test('blocks localhost', () => {
    expect(isPrivateHostname('localhost')).toBe(true)
    expect(isPrivateHostname('LOCALHOST')).toBe(true)
  })

  test('blocks 127.0.0.0/8 loopback including short/numeric/hex/octal forms (via URL normalization)', () => {
    expect(isPrivateHostname(hostOf('http://127.0.0.1/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://127.1/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://2130706433/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://0x7f000001/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://0177.0.0.1/'))).toBe(true)
  })

  test('blocks RFC1918 ranges', () => {
    expect(isPrivateHostname('10.0.0.1')).toBe(true)
    expect(isPrivateHostname('172.16.0.1')).toBe(true)
    expect(isPrivateHostname('172.31.255.255')).toBe(true)
    expect(isPrivateHostname('192.168.1.1')).toBe(true)
  })

  test('blocks 169.254.0.0/16 link-local (AWS/GCP metadata)', () => {
    expect(isPrivateHostname('169.254.169.254')).toBe(true)
  })

  test('blocks 100.64.0.0/10 CGNAT', () => {
    expect(isPrivateHostname('100.64.0.1')).toBe(true)
    expect(isPrivateHostname('100.127.255.255')).toBe(true)
  })

  test('blocks 0.0.0.0/8', () => {
    expect(isPrivateHostname('0.0.0.0')).toBe(true)
    expect(isPrivateHostname('0.1.2.3')).toBe(true)
  })

  test('allows public IPv4', () => {
    expect(isPrivateHostname('8.8.8.8')).toBe(false)
    expect(isPrivateHostname('172.15.0.1')).toBe(false) // just outside 172.16/12
    expect(isPrivateHostname('172.32.0.1')).toBe(false)
    expect(isPrivateHostname('100.63.255.255')).toBe(false) // just outside CGNAT
    expect(isPrivateHostname('100.128.0.0')).toBe(false)
  })

  test('allows regular hostnames', () => {
    expect(isPrivateHostname('example.com')).toBe(false)
    expect(isPrivateHostname('api.search.brave.com')).toBe(false)
  })
})

describe('isPrivateHostname — IPv6', () => {
  test('blocks ::1 loopback and :: unspecified', () => {
    expect(isPrivateHostname(hostOf('http://[::1]/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://[::]/'))).toBe(true)
  })

  test('blocks IPv4-mapped IPv6 pointing at private v4 (the previous bypass)', () => {
    // WHATWG URL normalizes [::ffff:127.0.0.1] → [::ffff:7f00:1]; must still block.
    expect(isPrivateHostname(hostOf('http://[::ffff:127.0.0.1]/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://[::ffff:7f00:1]/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://[::ffff:169.254.169.254]/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://[::ffff:10.0.0.1]/'))).toBe(true)
  })

  test('blocks ULA fc00::/7', () => {
    expect(isPrivateHostname(hostOf('http://[fc00::1]/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://[fd12:3456:789a::1]/'))).toBe(true)
  })

  test('blocks link-local fe80::/10', () => {
    expect(isPrivateHostname(hostOf('http://[fe80::1]/'))).toBe(true)
    expect(isPrivateHostname(hostOf('http://[febf::1]/'))).toBe(true)
  })

  test('allows public IPv6', () => {
    expect(isPrivateHostname(hostOf('http://[2001:4860:4860::8888]/'))).toBe(false)
    expect(isPrivateHostname(hostOf('http://[2606:4700:4700::1111]/'))).toBe(false)
  })

  test('malformed IPv6 is not classified as private (URL parser rejects it upstream)', () => {
    expect(isPrivateHostname('not:an:ipv6')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// readPositiveEnvNumber — WEB_CUSTOM_TIMEOUT_SEC / WEB_CUSTOM_MAX_BODY_KB
// ---------------------------------------------------------------------------

describe('readPositiveEnvNumber', () => {
  test('parses a valid positive override', () => {
    expect(readPositiveEnvNumber('45', 120)).toBe(45)
    expect(readPositiveEnvNumber('0.5', 120)).toBe(0.5)
  })

  test('falls back for missing / empty / non-numeric input', () => {
    expect(readPositiveEnvNumber(undefined, 120)).toBe(120)
    expect(readPositiveEnvNumber('', 120)).toBe(120)
    expect(readPositiveEnvNumber('fast', 120)).toBe(120)
  })

  test('falls back for zero and negative values instead of passing them through', () => {
    // The old `Number(x) || DEFAULT` idiom rescued 0 but let negatives past —
    // a negative timeout aborts every request and a negative body cap makes the
    // size guard reject every POST.
    expect(readPositiveEnvNumber('0', 120)).toBe(120)
    expect(readPositiveEnvNumber('-1', 120)).toBe(120)
    expect(readPositiveEnvNumber('-9999', 300)).toBe(300)
  })

  test('falls back for non-finite values (Infinity)', () => {
    expect(readPositiveEnvNumber('1e999', 120)).toBe(120)
  })
})

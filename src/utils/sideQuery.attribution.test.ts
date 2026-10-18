import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
} from '../bootstrap/state.js'
import { resetGrowthBook } from '../services/analytics/growthbook.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import { getClaudeAIOAuthTokens } from './auth.js'
import { enableConfigs } from './config.js'
import { SETTING_SOURCES } from './settings/constants.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import {
  providerModuleIsMocked,
  REAL_PROVIDER_TEST_CHILD_ENV,
  REAL_PROVIDER_TEST_TIMEOUT_MS,
  runTestFileWithRealProviders,
} from '../test/providerModuleIsolation.js'

// Bun keeps mock.module() registrations process-global across test files.
// Bind sideQuery only when the canonical provider module is real. When a prior
// file replaced it, run this file in a clean child process instead.
const _realProvidersModule = await import(
  `./model/providers.js?attributionReal=${Date.now()}-${Math.random()}`
)
const _loadedProvidersModule = await import('src/utils/model/providers.js')
const runInProviderIsolatedChild =
  process.env[REAL_PROVIDER_TEST_CHILD_ENV] !== '1' &&
  providerModuleIsMocked(_loadedProvidersModule, _realProvidersModule)
type SideQueryModule = typeof import('./sideQuery.js')
let sideQuery!: SideQueryModule['sideQuery']
if (!runInProviderIsolatedChild) {
  ;({ sideQuery } = await import(
    `./sideQuery.js?attributionReal=${Date.now()}-${Math.random()}`
  ))
}

const envKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_FEATURE_FLAGS_FILE',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENCLAUDE_CONFIG_DIR',
] as const
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const hadSavedMacro = Object.hasOwn(globalThis, 'MACRO')
const savedMacro = (globalThis as Record<string, unknown>).MACRO
const originalNodeEnv = process.env.NODE_ENV
let configRoot: string | undefined

function makeMessageResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-side-attribution-test',
      type: 'message',
      role: 'assistant',
      model: 'claude-side-attribution-test',
      content: [],
      container: null,
      context_management: null,
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    {
      headers: {
        'content-type': 'application/json',
        'request-id': 'req-side-attribution-test',
      },
    },
  )
}

async function captureSideQueryRequest(
  system:
    | string
    | Array<{
        type: 'text'
        text: string
        cache_control?: { type: 'ephemeral'; scope?: 'global' | 'org' }
      }> = 'stable side prompt',
): Promise<{
  system: Array<Record<string, unknown>>
  headers: Headers
}> {
  let requestBody: Record<string, unknown> | undefined
  let requestHeaders: Headers | undefined
  globalThis.fetch = (async (input, init) => {
    const request =
      input instanceof Request
        ? input.clone()
        : new Request(input as RequestInfo, init)
    const body = await request.text()
    if (body) requestBody = JSON.parse(body) as Record<string, unknown>
    requestHeaders = new Headers(request.headers)
    return makeMessageResponse()
  }) as typeof fetch

  await sideQuery({
    querySource: 'model_validation',
    model: 'claude-side-attribution-test',
    system,
    messages: [{ role: 'user', content: 'hello' }],
  })

  if (!Array.isArray(requestBody?.system)) {
    throw new Error('expected captured side-query system blocks')
  }
  if (!requestHeaders) {
    throw new Error('expected captured side-query request headers')
  }
  return {
    system: requestBody.system as Array<Record<string, unknown>>,
    headers: requestHeaders,
  }
}

async function captureSideQuerySystem(
  system:
    | string
    | Array<{
        type: 'text'
        text: string
        cache_control?: { type: 'ephemeral'; scope?: 'global' | 'org' }
      }> = 'stable side prompt',
): Promise<Array<Record<string, unknown>>> {
  return (await captureSideQueryRequest(system)).system
}

function blockTexts(blocks: Array<Record<string, unknown>>): string[] {
  return blocks.flatMap(block =>
    typeof block.text === 'string' ? [block.text] : [],
  )
}

beforeEach(async () => {
  await acquireSharedMutationLock('sideQuery.attribution.test.ts')
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  setAllowedSettingSources([...SETTING_SOURCES])
  resetSettingsCache()
  configRoot = mkdtempSync(join(tmpdir(), 'side-query-attribution-'))
  for (const key of envKeys) delete process.env[key]
  process.env.ANTHROPIC_API_KEY = 'sk-test-side-query'
  process.env.OPENCLAUDE_CONFIG_DIR = configRoot
  process.env.CLAUDE_FEATURE_FLAGS_FILE = join(
    configRoot,
    'feature-flags.json',
  )
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-test',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: 'test',
    ISSUES_EXPLAINER: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: undefined,
  }
  getClaudeAIOAuthTokens.cache?.clear?.()
  resetGrowthBook()
})

function setIgnoredApiKeyHelper(): void {
  delete process.env.ANTHROPIC_API_KEY
  setFlagSettingsPath(undefined)
  setFlagSettingsInline({ apiKeyHelper: 'ignored-test-helper' })
  setAllowedSettingSources(['flagSettings'])
  resetSettingsCache()
  enableConfigs()
  process.env.NODE_ENV = 'development'
}

afterEach(() => {
  try {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
    globalThis.fetch = originalFetch
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    setFlagSettingsPath(undefined)
    setFlagSettingsInline(null)
    setAllowedSettingSources([...SETTING_SOURCES])
    resetSettingsCache()
    if (hadSavedMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = savedMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
    getClaudeAIOAuthTokens.cache?.clear?.()
    resetGrowthBook()
    if (configRoot) {
      rmSync(configRoot, { recursive: true, force: true })
      configRoot = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

if (runInProviderIsolatedChild) {
  test('runs side-query attribution cases with the real provider module', async () => {
    await runTestFileWithRealProviders(import.meta.path)
  }, { timeout: REAL_PROVIDER_TEST_TIMEOUT_MS + 5_000 })
}

const describeAttribution = runInProviderIsolatedChild
  ? describe.skip
  : describe

describeAttribution('sideQuery Anthropic attribution', () => {
  for (const [label, envKey, envValue, ambientAuth] of [
    ['remote', 'CLAUDE_CODE_REMOTE', '1', 'api-key'],
    [
      'Claude Desktop',
      'CLAUDE_CODE_ENTRYPOINT',
      'claude-desktop',
      'api-key-helper',
    ],
    [
      'Unix-socket OAuth proxy',
      'ANTHROPIC_UNIX_SOCKET',
      '/tmp/openclaude-auth-test.sock',
      'auth-token',
    ],
  ] as const) {
    test(`uses OAuth headers and attribution in managed ${label} sessions`, async () => {
      process.env[envKey] = envValue
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
      process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
      if (ambientAuth === 'api-key-helper') setIgnoredApiKeyHelper()
      if (ambientAuth === 'auth-token') {
        process.env.ANTHROPIC_AUTH_TOKEN = 'ignored-test-auth-token'
      }
      getClaudeAIOAuthTokens.cache?.clear?.()

      const request = await captureSideQueryRequest()
      const texts = blockTexts(request.system)

      expect(
        texts.some(text => text.startsWith('x-anthropic-billing-header')),
      ).toBe(true)
      expect(request.headers.get('authorization')).toBe(
        'Bearer oauth-test-token',
      )
      expect(request.headers.has('x-api-key')).toBe(false)
    })
  }

  test('keeps Unix-socket API-key auth when the OAuth placeholder is absent', async () => {
    writeFileSync(
      join(configRoot!, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stored-test-oauth-token',
          refreshToken: null,
          expiresAt: null,
          scopes: ['user:inference'],
          subscriptionType: null,
          rateLimitTier: null,
        },
      }),
    )
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/openclaude-auth-test.sock'
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    getClaudeAIOAuthTokens.cache?.clear?.()

    const request = await captureSideQueryRequest()
    const texts = blockTexts(request.system)

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
    expect(request.headers.get('x-api-key')).toBe('sk-test-side-query')
    expect(request.headers.has('authorization')).toBe(false)
  })

  test('strips the block from a custom native endpoint', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://custom-anthropic.example/v1'

    const texts = blockTexts(
      await captureSideQuerySystem([
        { type: 'text', text: 'x-anthropic-billing-header: stale' },
        { type: 'text', text: 'stable side prompt' },
      ]),
    )

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
    expect(texts).toContain('stable side prompt')
  })

  test('honors the disabled setting for an official API key', async () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'

    const texts = blockTexts(await captureSideQuerySystem())

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
    expect(texts).toContain('stable side prompt')
  })

  test('keeps the block for official OAuth when globally disabled', async () => {
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    getClaudeAIOAuthTokens.cache?.clear?.()

    const texts = blockTexts(await captureSideQuerySystem())

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(true)
    expect(texts).toContain('stable side prompt')
  })

  test('keeps one generated block and preserves cache metadata order', async () => {
    const blocks = await captureSideQuerySystem([
      { type: 'text', text: 'x-anthropic-billing-header: stale' },
      {
        type: 'text',
        text: 'stable cached side prompt',
        cache_control: { type: 'ephemeral', scope: 'org' },
      },
    ])

    const texts = blockTexts(blocks)
    expect(
      texts.filter(text => text.startsWith('x-anthropic-billing-header')),
    ).toHaveLength(1)
    expect(texts[1]).toBe('stable cached side prompt')
    expect(blocks[1]?.cache_control).toEqual({
      type: 'ephemeral',
      scope: 'org',
    })
  })
})
